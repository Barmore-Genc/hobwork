import { afterEach, beforeEach, expect, test } from 'vitest'
import { queryLogs } from '../runtime/logs.ts'
import type { Interceptor, Upstream } from '../sandbox/sandbox.ts'
import { createTestHost } from '../test-host.ts'
import { createAiGateway, parseUsage } from './gateway.ts'
import { DEFAULT_LIMITS, saveHostAiSettings, saveProjectAiSettings } from './settings.ts'
import { projectUsage, pruneAiRequests } from './usage.ts'

const URL = 'https://openrouter.ai/api/v1/chat/completions'
const START = Date.parse('2026-09-01T12:00:00Z')

let host: ReturnType<typeof createTestHost>
let clock: number
let projectId: number
let sent: { body: Record<string, unknown>; authorization: string | null }[]

beforeEach(() => {
  host = createTestHost()
  clock = START
  sent = []
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
  return createAiGateway(host, { now: () => clock }).interceptor('filament', scope)!
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
    "This project sent 2 requests to OpenRouter in the last minute, and Hobwork allows 2. Try again in 40 seconds. People change this on the project's AI page in Hobwork.",
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
  expect(error.message).toContain('This project spent $0.06 on OpenRouter in the last 24 hours, and Hobwork stops it at $0.05. Try again in 22 hours.')
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
