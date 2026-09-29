import { expect, test } from 'vitest'
import { z } from 'zod'
import { openrouter, OpenRouterError, OPENROUTER_URL } from '../src/index.ts'
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
    'The project has no OPENROUTER_API_KEY secret',
  )
  await openrouter(createTestContext({ fetch }), { apiKey: 'GONDOLIN_SECRET_other' }).chat({ model: 'm', messages })
  expect(sent[0]?.headers.authorization).toBe('Bearer GONDOLIN_SECRET_other')
})
