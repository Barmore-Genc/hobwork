import { expect, test } from 'vitest'
import { z } from 'zod'
import { DEFAULT_JUDGE_MODEL, openrouter, OpenRouterError, OPENROUTER_URL } from '../src/index.ts'
import { createTestContext } from '../src/testing.ts'

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function fakeFetch(reply: { status?: number; body: unknown } | ((sent: Sent) => { status?: number; body: unknown })) {
  const sent: Sent[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const request: Sent = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) }
    sent.push(request)
    const { status = 200, body } = typeof reply === 'function' ? reply(request) : reply
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

function completion(content: string) {
  return { id: 'gen-1', model: 'openai/gpt-5-mini', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }
}

const secrets = { OPENROUTER_API_KEY: 'GONDOLIN_SECRET_or' }
const messages = [{ role: 'user' as const, content: 'How much filament is left?' }]

test('chat sends the request with the secret placeholder and returns the text', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('About 200g') })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  const reply = await ai.chat({ model: 'openai/gpt-5-mini', messages, temperature: 0.2 })
  expect(reply.text).toBe('About 200g')
  expect(reply.completion.id).toBe('gen-1')
  expect(sent).toEqual([
    {
      url: OPENROUTER_URL,
      headers: { authorization: 'Bearer GONDOLIN_SECRET_or', 'content-type': 'application/json' },
      body: { model: 'openai/gpt-5-mini', messages, temperature: 0.2 },
    },
  ])
})

test('json without a schema uses JSON mode and parses the reply', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('```json\n{"grams": 200}\n```') })
  const data = await openrouter(createTestContext({ fetch, secrets })).json({ model: 'm', messages })
  expect(data).toEqual({ grams: 200 })
  expect(sent[0]?.body.response_format).toEqual({ type: 'json_object' })
})

test('json with a zod schema sends it as a JSON schema and validates the reply', async () => {
  const Spool = z.object({ color: z.string(), grams: z.number() })
  const { fetch, sent } = fakeFetch({ body: completion('{"color":"red","grams":200}') })
  const spool = await openrouter(createTestContext({ fetch, secrets })).json({
    model: 'm',
    messages,
    schema: Spool,
    schemaName: 'spool',
    provider: { sort: 'price' },
  })
  const typed: { color: string; grams: number } = spool
  expect(typed).toEqual({ color: 'red', grams: 200 })
  expect(sent[0]?.body).toMatchObject({
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'spool',
        strict: true,
        schema: {
          type: 'object',
          properties: { color: { type: 'string' }, grams: { type: 'number' } },
          required: ['color', 'grams'],
          additionalProperties: false,
        },
      },
    },
    provider: { require_parameters: true, sort: 'price' },
  })
  expect(sent[0]?.body).not.toHaveProperty('schema')
  const { json_schema } = sent[0]!.body.response_format as { json_schema: { schema: object } }
  expect(json_schema.schema).not.toHaveProperty('$schema')
})

test('a reply that does not match the schema throws with the issues', async () => {
  const { fetch } = fakeFetch({ body: completion('{"color":"red"}') })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  const err = await ai.json({ model: 'm', messages, schema: z.object({ color: z.string(), grams: z.number() }) }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(OpenRouterError)
  expect(err).toMatchObject({ code: 'invalid_output', message: expect.stringContaining('grams:') })

  const { fetch: prose } = fakeFetch({ body: completion('Sure! Here it is') })
  await expect(openrouter(createTestContext({ fetch: prose, secrets })).json({ model: 'm', messages })).rejects.toMatchObject({
    code: 'invalid_json',
  })
})

test("OpenRouter errors throw with OpenRouter's message and status", async () => {
  const { fetch } = fakeFetch({ status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } })
  const err = await openrouter(createTestContext({ fetch, secrets })).chat({ model: 'm', messages }).catch((e: unknown) => e)
  expect(err).toMatchObject({ name: 'OpenRouterError', status: 402, code: 402, message: 'Insufficient credits' })

  const { fetch: blocked } = fakeFetch({ status: 403, body: 'egress blocked' })
  await expect(openrouter(createTestContext({ fetch: blocked, secrets })).chat({ model: 'm', messages })).rejects.toThrow(
    'OpenRouter answered HTTP 403: egress blocked',
  )
})

test("provider errors include the provider's message", async () => {
  const { fetch } = fakeFetch({
    status: 429,
    body: {
      error: {
        code: 429,
        message: 'Provider returned error',
        metadata: { raw: 'qwen/qwen3:free is temporarily rate-limited upstream.', provider_name: 'ModelRun' },
      },
    },
  })
  const err = await openrouter(createTestContext({ fetch, secrets })).chat({ model: 'm', messages }).catch((e: unknown) => e)
  expect(err).toMatchObject({
    status: 429,
    code: 429,
    message: 'Provider returned error (ModelRun): qwen/qwen3:free is temporarily rate-limited upstream.',
    metadata: { provider_name: 'ModelRun' },
  })
})

test('an error in an HTTP 200 answer throws with its code as the status', async () => {
  const { fetch } = fakeFetch({ body: { error: { code: 502, message: 'JSON error injected into SSE stream' } } })
  await expect(openrouter(createTestContext({ fetch, secrets })).chat({ model: 'm', messages })).rejects.toMatchObject({
    status: 502,
    code: 502,
    message: 'JSON error injected into SSE stream',
  })
})

test('json with a schema explains a model without structured output', async () => {
  const { fetch } = fakeFetch({
    status: 404,
    body: {
      error: {
        code: 404,
        message: 'No endpoints found that can handle the requested parameters.',
        metadata: { failed_routing_step: 'Filter by Parameters' },
      },
    },
  })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  await expect(ai.json({ model: 'stealth/model', messages, schema: z.object({ color: z.string() }) })).rejects.toMatchObject({
    status: 404,
    message: expect.stringContaining('stealth/model may not support structured output'),
  })
})

test('the answer may start with whitespace', async () => {
  const fetch = (async () => new Response(`\n\n   ${JSON.stringify(completion('pong'))}`)) as typeof globalThis.fetch
  const reply = await openrouter(createTestContext({ fetch, secrets })).chat({ model: 'm', messages })
  expect(reply.text).toBe('pong')
})

test('explains a missing secret and accepts another one', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('hi') })
  await expect(openrouter(createTestContext({ fetch })).chat({ model: 'm', messages })).rejects.toThrow(
    'The hob has no OPENROUTER_API_KEY secret',
  )
  await openrouter(createTestContext({ fetch }), { apiKey: 'GONDOLIN_SECRET_other' }).chat({ model: 'm', messages })
  expect(sent[0]?.headers.authorization).toBe('Bearer GONDOLIN_SECRET_other')
})

// Answers only when the request's signal aborts, like an upstream that hangs.
const hangingFetch = (async (_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  })) as typeof globalThis.fetch

test('a call times out with its own timeout or the client default', async () => {
  const ai = openrouter(createTestContext({ fetch: hangingFetch, secrets }), { timeout: 20 })
  await expect(ai.chat({ model: 'm', messages })).rejects.toMatchObject({
    name: 'OpenRouterError',
    code: 'timeout',
    message: 'OpenRouter did not answer within 20 ms',
  })
  await expect(ai.json({ model: 'm', messages }, { timeout: 10 })).rejects.toMatchObject({ code: 'timeout' })
})

test('a call stops when its signal aborts', async () => {
  const controller = new AbortController()
  const ai = openrouter(createTestContext({ fetch: hangingFetch, secrets }))
  const call = ai.json({ model: 'm', messages, schema: z.object({ color: z.string() }) }, { signal: controller.signal, timeout: 60_000 })
  controller.abort(new Error('the person closed the page'))
  await expect(call).rejects.toMatchObject({ code: 'aborted', cause: new Error('the person closed the page') })
})

test('Hobwork limits come back with their own codes', async () => {
  const { fetch } = fakeFetch({
    status: 429,
    body: {
      error: {
        code: 'hobwork_rate_limit',
        message: 'This hob sent 20 requests to OpenRouter in the last minute, and Hobwork allows 20. Try again in 12 seconds.',
        metadata: { limit: 'requestsPerMinute', retry_after_seconds: 12 },
      },
    },
  })
  const error = await openrouter(createTestContext({ fetch, secrets }))
    .chat({ model: 'm', messages })
    .catch((err: unknown) => err)
  expect(error).toBeInstanceOf(OpenRouterError)
  expect(error).toMatchObject({ status: 429, code: 'hobwork_rate_limit', metadata: { retry_after_seconds: 12 } })
})

test('check asks for a boolean with the data apart from the instruction', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('{"answer":true}') })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  expect(await ai.check('Is this a shipping notice?', { input: { subject: 'Your order shipped' } })).toBe(true)
  const body = sent[0]!.body as { model: string; temperature: number; max_tokens: number; messages: { role: string; content: string }[]; response_format: unknown; provider: unknown }
  expect(body.model).toBe(DEFAULT_JUDGE_MODEL)
  expect(body.temperature).toBe(0)
  expect(body.max_tokens).toBeLessThanOrEqual(100)
  expect(body.messages[0]!.content).toContain('Is this a shipping notice?')
  expect(body.messages[0]!.content).not.toContain('Your order shipped')
  expect(body.messages[1]).toEqual({ role: 'user', content: `<data>\n${JSON.stringify({ subject: 'Your order shipped' }, null, 2)}\n</data>` })
  expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: { properties: { answer: { type: 'boolean' } } } } })
  expect(body.provider).toEqual({ require_parameters: true })
})

test('check uses the given model and rejects an answer that is not a boolean', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('{"answer":"yes"}') })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  await expect(ai.check('Is it?', { model: 'openai/gpt-5-mini', input: 'text' })).rejects.toMatchObject({ code: 'invalid_output' })
  expect(sent[0]!.body.model).toBe('openai/gpt-5-mini')
  expect(sent).toHaveLength(1)
})

test('check rejects replies that are not JSON or have no answer', async () => {
  for (const content of ['true', '{"result":true}', 'null']) {
    const { fetch } = fakeFetch({ body: completion(content) })
    await expect(openrouter(createTestContext({ fetch, secrets })).check('Is it?')).rejects.toBeInstanceOf(OpenRouterError)
  }
})

test('pick returns one of the choices and sends them as an enum', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('{"answer":"bill"}') })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  const kind: 'bill' | 'promo' | 'other' = await ai.pick('What kind of email is this?', ['bill', 'promo', 'other'] as const, { input: 'Invoice due' })
  expect(kind).toBe('bill')
  expect(sent[0]!.body).toMatchObject({
    response_format: { json_schema: { schema: { properties: { answer: { type: 'string', enum: ['bill', 'promo', 'other'] } } } } },
  })
})

test('pick accepts an object of choices and descriptions', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('{"answer":"urgent"}') })
  const level = await openrouter(createTestContext({ fetch, secrets })).pick('How urgent is it?', { urgent: 'needs action today', later: 'can wait' })
  const typed: 'urgent' | 'later' = level
  expect(typed).toBe('urgent')
  const system = (sent[0]!.body.messages as { content: string }[])[0]!.content
  expect(system).toContain('- urgent: needs action today')
  expect(system).toContain('- later: can wait')
})

test('pick rejects an answer outside the choices', async () => {
  for (const content of ['{"answer":"spam"}', '{"answer":"Bill"}', '{"answer":["bill"]}', '{"answer":null}']) {
    const { fetch, sent } = fakeFetch({ body: completion(content) })
    await expect(openrouter(createTestContext({ fetch, secrets })).pick('Kind?', ['bill', 'promo'])).rejects.toMatchObject({ code: 'invalid_output' })
    expect(sent).toHaveLength(1)
  }
})

test('pick rejects empty and duplicate choices before calling OpenRouter', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('{"answer":"a"}') })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  await expect(ai.pick('Kind?', [])).rejects.toThrow('at least one')
  await expect(ai.pick('Kind?', ['a', 'a'])).rejects.toThrow('unique')
  expect(sent).toHaveLength(0)
})
