import { afterEach, beforeEach, expect, test } from 'vitest'
import { queryLogs } from '../runtime/logs.ts'
import type { Interceptor, Upstream } from '../sandbox/sandbox.ts'
import { createTestHost } from '../test-host.ts'
import { createAiGateway, parseUsage } from './gateway.ts'
import { openRouterPrices, parsePriceList, FALLBACK_PRICE, type PriceList } from './pricing.ts'
import { DEFAULT_LIMITS, saveHostAiSettings, saveProjectAiSettings } from './settings.ts'
import { projectUsage, pruneAiRequests } from './usage.ts'

const URL = 'https://openrouter.ai/api/v1/chat/completions'
const START = Date.parse('2026-09-01T12:00:00Z')

let host: ReturnType<typeof createTestHost>
let clock: number
let projectId: number
let prices: PriceList
let sent: { body: Record<string, unknown>; authorization: string | null }[]

beforeEach(() => {
  host = createTestHost()
  clock = START
  sent = []
  prices = parsePriceList({ data: [{ id: 'openai/gpt-5-mini', pricing: { prompt: '0.000001', completion: '0.000002', request: '0' } }] })
  projectId = Number(host.db.prepare("INSERT INTO projects (name) VALUES ('filament') RETURNING id").get()!.id)
})
afterEach(() => host.dispose())

function fakeOpenRouter(reply: (body: Record<string, unknown>) => Response = () => completion(0.01)): Upstream {
  return async (request) => {
    sent.push({ body: (await request.json()) as Record<string, unknown>, authorization: request.headers.get('authorization') })
    return reply(sent.at(-1)!.body)
  }
}

function completion(cost: number, tokens = [10, 5]) {
  return Response.json({
    id: 'gen-1',
    model: 'openai/gpt-5-mini',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    usage: { prompt_tokens: tokens[0], completion_tokens: tokens[1], total_tokens: tokens[0]! + tokens[1]!, cost },
  })
}

function gateway(scope: Parameters<ReturnType<typeof createAiGateway>['interceptor']>[1] = { source: 'runtime' }): Interceptor {
  return createAiGateway(host, { now: () => clock, prices: async () => prices }).interceptor('filament', scope)!
}

function call(intercept: Interceptor, body: unknown, upstream = fakeOpenRouter()) {
  return intercept.handle(
    new Request(URL, {
      method: 'POST',
      headers: { authorization: 'Bearer GONDOLIN_SECRET_x', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    upstream,
  )
}

const chat = (model = 'openai/gpt-5-mini') => ({ model, messages: [{ role: 'user', content: 'hi' }] })

test('forwards requests, asks for usage and records requests, tokens and cost', async () => {
  const res = await call(gateway(), chat())
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ choices: [{ message: { content: 'hi' } }] })
  expect(sent[0]).toEqual({ body: { ...chat(), usage: { include: true } }, authorization: 'Bearer GONDOLIN_SECRET_x' })
  const usage = projectUsage(host.db, projectId, clock)
  expect(usage.day).toEqual({ requests: 1, refused: 0, promptTokens: 10, completionTokens: 5, cost: 0.01 })
  expect(usage.models).toEqual([{ model: 'openai/gpt-5-mini', requests: 1, refused: 0, promptTokens: 10, completionTokens: 5, cost: 0.01 }])
})

test('passes GET requests through without counting them', async () => {
  const res = await gateway().handle(new Request('https://openrouter.ai/api/v1/models'), async () => Response.json({ data: [] }))
  expect(await res.json()).toEqual({ data: [] })
  expect(projectUsage(host.db, projectId, clock).day.requests).toBe(0)
})

test('refuses models outside the host and project lists with a clear error', async () => {
  saveHostAiSettings(host.db, { models: ['openai/*', 'google/gemini-2.5-flash'], limits: DEFAULT_LIMITS }, null)
  const intercept = gateway()
  expect((await call(intercept, chat('openai/gpt-5-mini'))).status).toBe(200)

  const refused = await call(intercept, chat('anthropic/claude-opus-4.1'))
  expect(refused.status).toBe(403)
  const { error } = (await refused.json()) as { error: { code: string; message: string; metadata: unknown } }
  expect(error.code).toBe('hobwork_model_not_allowed')
  expect(error.message).toContain('Hobwork does not let this project use anthropic/claude-opus-4.1. It may use openai/*, google/gemini-2.5-flash.')

  // A fallback model counts too.
  expect((await call(intercept, { ...chat(), models: ['anthropic/claude-opus-4.1'] })).status).toBe(403)
  // Without a model OpenRouter would use the account's default.
  expect((await call(intercept, { messages: [] })).status).toBe(403)

  // The project list narrows the host list; it cannot widen it.
  saveProjectAiSettings(host.db, projectId, { models: ['google/gemini-2.5-flash', 'anthropic/*'], limits: null }, null)
  expect((await call(intercept, chat('openai/gpt-5-mini'))).status).toBe(403)
  expect((await call(intercept, chat('anthropic/claude-opus-4.1'))).status).toBe(403)
  expect((await call(intercept, chat('google/gemini-2.5-flash'))).status).toBe(200)

  expect(sent.map((s) => s.body.model)).toEqual(['openai/gpt-5-mini', 'google/gemini-2.5-flash'])
  expect(projectUsage(host.db, projectId, clock).day).toMatchObject({ requests: 2, refused: 5 })
  const logs = queryLogs(host, { project: 'filament', limit: 100 })
  expect(logs.filter((line) => line.event === 'ai-limit')).toHaveLength(1)
})

test('throttles requests per minute and lets them through when the window moves', async () => {
  saveProjectAiSettings(host.db, projectId, { models: null, limits: { ...DEFAULT_LIMITS, requestsPerMinute: 2 } }, null)
  const intercept = gateway({ source: 'preview', branch: 'try-ai' })
  expect((await call(intercept, chat())).status).toBe(200)
  clock += 10_000
  expect((await call(intercept, chat())).status).toBe(200)
  clock += 10_000
  const refused = await call(intercept, chat())
  expect(refused.status).toBe(429)
  expect(refused.headers.get('retry-after')).toBe('40')
  const { error } = (await refused.json()) as { error: { code: string; message: string; metadata: unknown } }
  expect(error).toMatchObject({
    code: 'hobwork_rate_limit',
    metadata: { limit: 'requestsPerMinute', max: 2, used: 2, retry_after_seconds: 40 },
  })
  expect(error.message).toBe(
    "This hob sent 2 requests to OpenRouter in the last minute, and Hobwork allows 2. Try again in 40 seconds. People change this on the hob's AI page in Hobwork.",
  )
  // Refused requests do not keep the project throttled.
  clock += 40_001
  expect((await call(intercept, chat())).status).toBe(200)
  const [line] = queryLogs(host, { project: 'filament', limit: 100 }).filter((l) => l.event === 'ai-limit')
  expect(line?.branch).toBe('try-ai')
})

test('stops a project at its spend limit until old spend leaves the window', async () => {
  saveHostAiSettings(host.db, { models: null, limits: { ...DEFAULT_LIMITS, costPerDay: 0.05 } }, null)
  const intercept = gateway()
  const upstream = fakeOpenRouter(() => completion(0.03))
  expect((await call(intercept, chat(), upstream)).status).toBe(200)
  clock += 60 * 60_000
  expect((await call(intercept, chat(), upstream)).status).toBe(200)
  clock += 60 * 60_000
  const refused = await call(intercept, chat(), upstream)
  expect(refused.status).toBe(429)
  const { error } = (await refused.json()) as { error: { code: string; message: string; metadata: unknown } }
  expect(error.code).toBe('hobwork_spend_limit')
  expect(error.message).toContain('This hob spent $0.06 on OpenRouter in the last 24 hours, and Hobwork stops it at $0.05. Try again in 22 hours.')
  clock += 22 * 60 * 60_000 + 1
  expect((await call(intercept, chat(), upstream)).status).toBe(200)
})

test('turning the throttle off leaves only the model list', async () => {
  saveHostAiSettings(host.db, { models: null, limits: { ...DEFAULT_LIMITS, requestsPerMinute: 1, throttle: false } }, null)
  const intercept = gateway()
  for (let i = 0; i < 3; i++) expect((await call(intercept, chat())).status).toBe(200)
})

test('passes on OpenRouter errors and records their status', async () => {
  const res = await call(gateway(), chat(), fakeOpenRouter(() => Response.json({ error: { code: 402, message: 'Insufficient credits' } }, { status: 402 })))
  expect(res.status).toBe(402)
  expect(await res.json()).toMatchObject({ error: { message: 'Insufficient credits' } })
  const row = host.db.prepare('SELECT status, cost, finished_at FROM ai_requests').get()
  expect(row).toMatchObject({ status: 402, cost: null })
  expect(row!.finished_at).not.toBeNull()
})

test('records a failed upstream as 502 and rethrows', async () => {
  await expect(call(gateway(), chat(), async () => { throw new Error('connect ECONNREFUSED') })).rejects.toThrow('ECONNREFUSED')
  expect(host.db.prepare('SELECT status FROM ai_requests').get()).toEqual({ status: 502 })
})

test('asks for usage whatever the guest sent', async () => {
  await call(gateway(), { ...chat(), usage: { include: false } })
  await call(gateway(), { ...chat(), usage: 'no' })
  await call(gateway(), chat())
  expect(sent.map((s) => s.body.usage)).toEqual([{ include: true }, { include: true }, { include: true }])
})

test('reads usage from streamed responses', async () => {
  const stream = [
    ': OPENROUTER PROCESSING',
    'data: {"choices":[{"delta":{"content":"h"}}]}',
    'data: {"choices":[{"delta":{"content":"i"}}],"usage":{"prompt_tokens":7,"completion_tokens":2,"cost":0.002}}',
    'data: [DONE]',
    '',
  ].join('\n\n')
  const res = await call(gateway(), { ...chat(), stream: true }, fakeOpenRouter(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })))
  expect(await res.text()).toBe(stream)
  expect(projectUsage(host.db, projectId, clock).day).toMatchObject({ requests: 1, promptTokens: 7, completionTokens: 2, cost: 0.002 })
})

test('parses usage from the chat, messages and responses formats', () => {
  expect(parseUsage('{"usage":{"input_tokens":3,"output_tokens":4}}', 'application/json')).toEqual({
    promptTokens: 3,
    completionTokens: 4,
    cost: undefined,
  })
  expect(parseUsage('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2,"cost":0.5}}}\n\n', null)).toEqual({
    promptTokens: 1,
    completionTokens: 2,
    cost: 0.5,
  })
  expect(parseUsage('not json', 'text/plain')).toBeUndefined()
})

test('keeps 90 days of requests', async () => {
  await call(gateway(), chat())
  clock += 91 * 24 * 60 * 60_000
  expect(pruneAiRequests(host.db, clock)).toBe(1)
})

test('has no interceptor for a project that does not exist', () => {
  expect(createAiGateway(host).interceptor('nope', { source: 'runtime' })).toBeUndefined()
})

test('refuses plain http to OpenRouter without sending it on', async () => {
  let forwarded = false
  const upstream: Upstream = async () => {
    forwarded = true
    return completion(0.01)
  }
  const res = await gateway().handle(
    new Request('http://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer GONDOLIN_SECRET_x' },
      body: JSON.stringify(chat()),
    }),
    upstream,
  )
  expect(res.status).toBe(403)
  const { error } = (await res.json()) as { error: { code: string; message: string } }
  expect(error.code).toBe('hobwork_https_required')
  expect(error.message).toBe('Hobwork only lets hobs reach OpenRouter over https. Use https://openrouter.ai/api/v1.')
  const get = await gateway().handle(new Request('http://openrouter.ai/api/v1/models'), upstream)
  expect(get.status).toBe(403)
  expect(forwarded).toBe(false)
  expect(projectUsage(host.db, projectId, clock).day.requests).toBe(0)
})

test('refuses OpenRouter on ports other than 443', async () => {
  let forwarded = false
  const upstream: Upstream = async () => {
    forwarded = true
    return completion(0.01)
  }
  for (const origin of ['https://openrouter.ai:8443', 'https://openrouter.ai:80']) {
    const res = await gateway().handle(new Request(`${origin}/api/v1/models`), upstream)
    expect(res.status).toBe(403)
    const { error } = (await res.json()) as { error: { code: string } }
    expect(error.code).toBe('hobwork_port_not_allowed')
  }
  const ok = await gateway().handle(new Request('https://openrouter.ai:443/api/v1/models'), async () => Response.json({ data: [] }))
  expect(ok.status).toBe(200)
  expect(forwarded).toBe(false)
})

test('only passes on the OpenRouter paths hobs use', async () => {
  let forwarded: string[] = []
  const upstream: Upstream = async (request) => {
    forwarded.push(`${request.method} ${new globalThis.URL(request.url).pathname}`)
    return completion(0.01)
  }
  const send = (method: string, path: string) =>
    gateway().handle(
      new Request(`https://openrouter.ai${path}`, { method, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(chat()) }),
      upstream,
    )
  for (const [method, path] of [
    ['POST', '/api/v1/chat/completions'],
    ['POST', '/api/v1/completions'],
    ['POST', '/api/v1/messages'],
    ['POST', '/api/v1/responses'],
    ['POST', '/api/v1/embeddings'],
    ['GET', '/api/v1/models'],
    ['GET', '/api/v1/models/openai/gpt-5-mini/endpoints'],
    ['GET', '/api/v1/key'],
  ] as const) {
    expect((await send(method, path)).status, `${method} ${path}`).toBe(200)
  }
  forwarded = []
  for (const [method, path] of [
    ['POST', '/api/v1/keys'],
    ['GET', '/api/v1/keys'],
    ['DELETE', '/api/v1/keys/abc'],
    ['POST', '/api/v1/credits/coinbase'],
    ['POST', '/api/v1/chat/completions/extra'],
    ['GET', '/api/v1/chat/completions'],
    ['POST', '/api/v1/models'],
    ['POST', '/api/v1/auth/keys'],
    ['GET', '/'],
    ['POST', '/v1/chat/completions'],
    ['POST', '/api/v1/../keys'],
  ] as const) {
    const res = await send(method, path)
    expect(res.status, `${method} ${path}`).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('hobwork_path_not_allowed')
  }
  expect(forwarded).toEqual([])
  const refusal = await send('DELETE', '/api/v1/keys/abc')
  expect(((await refusal.json()) as { error: { message: string } }).error.message).toBe(
    'Hobwork does not let hobs call DELETE /api/v1/keys/abc on OpenRouter. Hobs can use the chat, completions, messages, responses and embeddings endpoints and read model lists.',
  )
})

test('estimates the cost from tokens and the model price when OpenRouter reports none', async () => {
  const noCost = fakeOpenRouter(() => Response.json({ model: 'openai/gpt-5-mini', usage: { prompt_tokens: 1000, completion_tokens: 500 } }))
  expect((await call(gateway(), chat(), noCost)).status).toBe(200)
  const row = host.db.prepare('SELECT prompt_tokens, completion_tokens, cost FROM ai_requests').get()
  expect(row).toEqual({ prompt_tokens: 1000, completion_tokens: 500, cost: 1000 * 0.000001 + 500 * 0.000002 })
})

test('estimates with a high price for models it has no price for, and from sizes when there are no tokens', async () => {
  const bare = fakeOpenRouter(() => Response.json({ model: 'some/new-model', choices: [{ message: { content: 'x'.repeat(400) } }] }))
  const body = chat('some/new-model')
  await call(gateway(), body, bare)
  const row = host.db.prepare('SELECT prompt_tokens, completion_tokens, cost FROM ai_requests').get()!
  const promptTokens = Math.ceil(JSON.stringify(body).length / 4)
  expect(row.prompt_tokens).toBe(promptTokens)
  expect(Number(row.completion_tokens)).toBeGreaterThan(100)
  expect(row.cost).toBe(promptTokens * FALLBACK_PRICE.prompt + Number(row.completion_tokens) * FALLBACK_PRICE.completion)
})

test('counts estimated cost against the spend limit', async () => {
  saveHostAiSettings(host.db, { models: null, limits: { ...DEFAULT_LIMITS, costPerDay: 0.001 } }, null)
  const intercept = gateway()
  const noCost = fakeOpenRouter(() => Response.json({ model: 'openai/gpt-5-mini', usage: { prompt_tokens: 1000, completion_tokens: 500 } }))
  expect((await call(intercept, chat(), noCost)).status).toBe(200)
  expect((await call(intercept, chat(), noCost)).status).toBe(429)
})

test('keeps a reported cost of zero and does not bill error answers', async () => {
  await call(gateway(), chat(), fakeOpenRouter(() => completion(0)))
  await call(gateway(), chat(), fakeOpenRouter(() => Response.json({ error: { message: 'no' } }, { status: 500 })))
  expect(projectUsage(host.db, projectId, clock).day.cost).toBe(0)
})

test('reads model prices from the OpenRouter list and keeps them for an hour', async () => {
  let calls = 0
  let time = 0
  const fetchImpl = (async () => {
    calls++
    return Response.json({ data: [{ id: 'A/B', pricing: { prompt: '0.001', completion: '0.002' } }, { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } }] })
  }) as typeof fetch
  const source = openRouterPrices(fetchImpl, () => time)
  expect([...(await source()).keys()]).toEqual(['a/b'])
  time += 59 * 60_000
  await source()
  expect(calls).toBe(1)
  time += 2 * 60_000
  await source()
  expect(calls).toBe(2)
})
