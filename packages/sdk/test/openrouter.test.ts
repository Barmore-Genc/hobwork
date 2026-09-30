import { expect, test } from 'vitest'
import { z } from 'zod'
import { DECISIONS_URL, EMBEDDINGS_URL, openrouter, OpenRouterError, OPENROUTER_URL } from '../src/index.ts'
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
  const reply = await ai.chat({ messages, temperature: 0.2 })
  expect(reply.text).toBe('About 200g')
  expect(reply.completion.id).toBe('gen-1')
  expect(sent).toEqual([
    {
      url: OPENROUTER_URL,
      headers: { authorization: 'Bearer GONDOLIN_SECRET_or', 'content-type': 'application/json' },
      body: { messages, temperature: 0.2 },
    },
  ])
})

test('json without a schema uses JSON mode and parses the reply', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('```json\n{"grams": 200}\n```') })
  const data = await openrouter(createTestContext({ fetch, secrets })).json({ messages })
  expect(data).toEqual({ grams: 200 })
  expect(sent[0]?.body.response_format).toEqual({ type: 'json_object' })
})

test('json with a zod schema sends it as a JSON schema and validates the reply', async () => {
  const Spool = z.object({ color: z.string(), grams: z.number() })
  const { fetch, sent } = fakeFetch({ body: completion('{"color":"red","grams":200}') })
  const spool = await openrouter(createTestContext({ fetch, secrets })).json({
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
  const err = await ai.json({ messages, schema: z.object({ color: z.string(), grams: z.number() }) }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(OpenRouterError)
  expect(err).toMatchObject({ code: 'invalid_output', message: expect.stringContaining('grams:') })

  const { fetch: prose } = fakeFetch({ body: completion('Sure! Here it is') })
  await expect(openrouter(createTestContext({ fetch: prose, secrets })).json({ messages })).rejects.toMatchObject({
    code: 'invalid_json',
  })
})

test("OpenRouter errors throw with OpenRouter's message and status", async () => {
  const { fetch } = fakeFetch({ status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } })
  const err = await openrouter(createTestContext({ fetch, secrets })).chat({ messages }).catch((e: unknown) => e)
  expect(err).toMatchObject({ name: 'OpenRouterError', status: 402, code: 402, message: 'Insufficient credits' })

  const { fetch: blocked } = fakeFetch({ status: 403, body: 'egress blocked' })
  await expect(openrouter(createTestContext({ fetch: blocked, secrets })).chat({ messages })).rejects.toThrow(
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
  const err = await openrouter(createTestContext({ fetch, secrets })).chat({ messages }).catch((e: unknown) => e)
  expect(err).toMatchObject({
    status: 429,
    code: 429,
    message: 'Provider returned error (ModelRun): qwen/qwen3:free is temporarily rate-limited upstream.',
    metadata: { provider_name: 'ModelRun' },
  })
})

test('an error in an HTTP 200 answer throws with its code as the status', async () => {
  const { fetch } = fakeFetch({ body: { error: { code: 502, message: 'JSON error injected into SSE stream' } } })
  await expect(openrouter(createTestContext({ fetch, secrets })).chat({ messages })).rejects.toMatchObject({
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
  await expect(ai.json({ messages, schema: z.object({ color: z.string() }) })).rejects.toMatchObject({
    status: 404,
    message: expect.stringContaining('may not support structured output'),
  })
})

test('the answer may start with whitespace', async () => {
  const fetch = (async () => new Response(`\n\n   ${JSON.stringify(completion('pong'))}`)) as typeof globalThis.fetch
  const reply = await openrouter(createTestContext({ fetch, secrets })).chat({ messages })
  expect(reply.text).toBe('pong')
})

test('explains a missing secret and accepts another one', async () => {
  const { fetch, sent } = fakeFetch({ body: completion('hi') })
  await expect(openrouter(createTestContext({ fetch })).chat({ messages })).rejects.toThrow(
    'The hob has no OPENROUTER_API_KEY secret',
  )
  await openrouter(createTestContext({ fetch }), { apiKey: 'GONDOLIN_SECRET_other' }).chat({ messages })
  expect(sent[0]?.headers.authorization).toBe('Bearer GONDOLIN_SECRET_other')
})

// Answers only when the request's signal aborts, like an upstream that hangs.
const hangingFetch = (async (_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  })) as typeof globalThis.fetch

test('a call times out with its own timeout or the client default', async () => {
  const ai = openrouter(createTestContext({ fetch: hangingFetch, secrets }), { timeout: 20 })
  await expect(ai.chat({ messages })).rejects.toMatchObject({
    name: 'OpenRouterError',
    code: 'timeout',
    message: 'OpenRouter did not answer within 20 ms',
  })
  await expect(ai.json({ messages }, { timeout: 10 })).rejects.toMatchObject({ code: 'timeout' })
})

test('a call stops when its signal aborts', async () => {
  const controller = new AbortController()
  const ai = openrouter(createTestContext({ fetch: hangingFetch, secrets }))
  const call = ai.json({ messages, schema: z.object({ color: z.string() }) }, { signal: controller.signal, timeout: 60_000 })
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
    .chat({ messages })
    .catch((err: unknown) => err)
  expect(error).toBeInstanceOf(OpenRouterError)
  expect(error).toMatchObject({ status: 429, code: 'hobwork_rate_limit', metadata: { retry_after_seconds: 12 } })
})

function decision(answers: Record<string, unknown>) {
  return { id: 'gen-dec-1', model: 'typesafe/jev-1.13-20260917', answers, usage: { input_tokens: 40, output_tokens: 3, cost: 0.000002 } }
}

test('decide asks the Decisions API and types the answers by question', async () => {
  const { fetch, sent } = fakeFetch({
    body: decision({
      bug: { type: 'noul', noul: 0.9 },
      team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.8, frontend: 0.2 }, confidence: 0.6 },
      urgency: { type: 'score', score: 1.9 },
    }),
  })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  const questions = {
    bug: { type: 'noul', instructions: 'Is the customer reporting a defect?' },
    team: { type: 'choice', instructions: 'Which team owns this?', criteria: { payments: 'Checkout', frontend: null } },
    urgency: { type: 'score', instructions: 'How urgent is it?', criteria: ['Later', 'This week', 'Now'] },
  } as const
  const { answers, model } = await ai.decide({ state: { ticket: 'Pay button shows a blank page' }, questions })
  const team: 'payments' | 'frontend' = answers.team.choice
  expect(team).toBe('payments')
  expect(answers.bug.noul).toBe(0.9)
  expect(answers.urgency.score).toBe(1.9)
  expect(model).toBe('typesafe/jev-1.13-20260917')
  expect(sent).toEqual([
    {
      url: DECISIONS_URL,
      headers: { authorization: 'Bearer GONDOLIN_SECRET_or', 'content-type': 'application/json' },
      body: { state: { ticket: 'Pay button shows a blank page' }, questions },
    },
  ])
})

test('decide rejects answers that do not fit their questions', async () => {
  const questions = { kind: { type: 'choice', instructions: 'Kind?', criteria: { bill: null, promo: null } } } as const
  for (const answers of [{}, { kind: { type: 'noul', noul: 1 } }, { kind: { type: 'choice', choice: 'spam' } }, { kind: { type: 'choice', choice: 'toString' } }]) {
    const { fetch } = fakeFetch({ body: decision(answers) })
    await expect(openrouter(createTestContext({ fetch, secrets })).decide({ state: 'x', questions })).rejects.toMatchObject({ code: 'invalid_output' })
  }
})

test('check asks a noul question about the input and compares with the threshold', async () => {
  const { fetch, sent } = fakeFetch({ body: decision({ answer: { type: 'noul', noul: 0.7 } }) })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  expect(await ai.check('Is this a shipping notice?', { input: { subject: 'Your order shipped' } })).toBe(true)
  expect(await ai.check('Is this a shipping notice?', { input: 'Your order shipped', threshold: 0.8 })).toBe(false)
  expect(await ai.check('Is it?')).toBe(true)
  expect(sent.map((s) => s.url)).toEqual([DECISIONS_URL, DECISIONS_URL, DECISIONS_URL])
  expect(sent.map((s) => s.body)).toEqual([
    { state: { subject: 'Your order shipped' }, questions: { answer: { type: 'noul', instructions: 'Is this a shipping notice?' } } },
    { state: 'Your order shipped', questions: { answer: { type: 'noul', instructions: 'Is this a shipping notice?' } } },
    { state: '(no data)', questions: { answer: { type: 'noul', instructions: 'Is it?' } } },
  ])
})

test('check rejects an answer that is not a noul', async () => {
  for (const answer of [{ type: 'noul', noul: 'yes' }, { type: 'choice', choice: 'true' }, undefined]) {
    const { fetch } = fakeFetch({ body: decision({ answer }) })
    await expect(openrouter(createTestContext({ fetch, secrets })).check('Is it?')).rejects.toMatchObject({ code: 'invalid_output' })
  }
})

test('pick sends the choices as a choice question', async () => {
  const { fetch, sent } = fakeFetch({ body: decision({ answer: { type: 'choice', choice: 'bill' } }) })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  const kind: 'bill' | 'promo' | 'other' = await ai.pick('What kind of email is this?', ['bill', 'promo', 'other'] as const, { input: 'Invoice due' })
  expect(kind).toBe('bill')
  expect(sent[0]!.body).toEqual({
    state: 'Invoice due',
    questions: { answer: { type: 'choice', instructions: 'What kind of email is this?', criteria: { bill: null, promo: null, other: null } } },
  })
})

test('pick accepts an object of choices and descriptions', async () => {
  const { fetch, sent } = fakeFetch({ body: decision({ answer: { type: 'choice', choice: 'urgent' } }) })
  const level = await openrouter(createTestContext({ fetch, secrets })).pick('How urgent is it?', { urgent: 'needs action today', later: 'can wait' })
  const typed: 'urgent' | 'later' = level
  expect(typed).toBe('urgent')
  expect(sent[0]!.body.questions).toEqual({
    answer: { type: 'choice', instructions: 'How urgent is it?', criteria: { urgent: 'needs action today', later: 'can wait' } },
  })
})

test('pick rejects an answer outside the choices', async () => {
  for (const choice of ['spam', 'Bill', ['bill'], null]) {
    const { fetch, sent } = fakeFetch({ body: decision({ answer: { type: 'choice', choice } }) })
    await expect(openrouter(createTestContext({ fetch, secrets })).pick('Kind?', ['bill', 'promo'])).rejects.toMatchObject({ code: 'invalid_output' })
    expect(sent).toHaveLength(1)
  }
})

test('pick rejects too few and duplicate choices before calling OpenRouter', async () => {
  const { fetch, sent } = fakeFetch({ body: decision({}) })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  await expect(ai.pick('Kind?', [])).rejects.toThrow('at least two')
  await expect(ai.pick('Kind?', ['a'])).rejects.toThrow('at least two')
  await expect(ai.pick('Kind?', ['a', 'a'])).rejects.toThrow('unique')
  expect(sent).toHaveLength(0)
})

test('embed sends the inputs and returns one vector per input in order', async () => {
  const { fetch, sent } = fakeFetch({
    body: {
      model: 'openai/text-embedding-3-small',
      data: [{ index: 1, embedding: [0.3, 0.4] }, { index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 4, total_tokens: 4 },
    },
  })
  const ai = openrouter(createTestContext({ fetch, secrets }))
  const result = await ai.embed(['red PLA', 'blue PETG'])
  expect(result).toEqual({ embeddings: [[0.1, 0.2], [0.3, 0.4]], model: 'openai/text-embedding-3-small', usage: { prompt_tokens: 4, total_tokens: 4 } })
  expect(sent[0]).toMatchObject({ url: EMBEDDINGS_URL, body: { input: ['red PLA', 'blue PETG'] } })
})

test('embed takes one string and rejects answers without a vector per input', async () => {
  const { fetch, sent } = fakeFetch({ body: { model: 'm', data: [{ index: 0, embedding: [1] }] } })
  expect((await openrouter(createTestContext({ fetch, secrets })).embed('red PLA')).embeddings).toEqual([[1]])
  expect(sent[0]!.body).toEqual({ input: ['red PLA'] })
  const short = fakeFetch({ body: { model: 'm', data: [{ index: 0, embedding: [1] }] } })
  await expect(openrouter(createTestContext({ fetch: short.fetch, secrets })).embed(['a', 'b'])).rejects.toMatchObject({ code: 'invalid_output' })
})
