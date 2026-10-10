import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { parseCatalog } from '../ai/catalog.ts'
import { createAiGateway } from '../ai/gateway.ts'
import { DEFAULT_LIMITS, type AiConfig } from '../ai/settings.ts'
import { createProject } from '../projects.ts'
import { createSecretStore } from '../secrets.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'

const catalog = parseCatalog({
  data: [
    { id: 'deepseek/deepseek-v4.1-flash', architecture: { output_modalities: ['text'] } },
    { id: 'google/gemini-2.5-flash', architecture: { output_modalities: ['text'], input_modalities: ['text', 'image'] } },
    { id: 'typesafe/jev-1.13', architecture: { output_modalities: ['decisions'] } },
    { id: 'openai/text-embedding-3-small', architecture: { output_modalities: ['embeddings'] } },
    { id: 'qwen/qwen3-embedding-8b', architecture: { output_modalities: ['embeddings'] } },
  ],
})
const ai: AiConfig = {
  models: { model: 'deepseek/deepseek-v4.1-flash', decisionModel: 'typesafe/jev-1.13', embeddingModel: 'openai/text-embedding-3-small', visionModel: 'google/gemini-3.1-flash-lite' },
  catalog: async () => catalog,
}

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string

beforeEach(async () => {
  host = createTestHost()
  cookie = signedIn(host).cookie
  await createProject(host, 'filament')
  app = await startTestApp(host, { ai })
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = writeHeaders(cookie)) {
  return fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

test('host-wide settings start with the environment and are saved by people', async () => {
  const initial = await (await call('GET', '/api/settings/ai')).json()
  expect(initial).toMatchObject({
    model: null,
    decisionModel: null,
    models: ai.models,
    limits: DEFAULT_LIMITS,
    defaults: { models: ai.models, limits: DEFAULT_LIMITS },
    updatedBy: null,
    usage: [],
  })

  const limits = { ...DEFAULT_LIMITS, requestsPerMinute: 5, costPerMonth: null }
  const res = await call('PUT', '/api/settings/ai', {
    model: ' google/gemini-2.5-flash ',
    decisionModel: false,
    embeddingModel: 'qwen/qwen3-embedding-8b',
    limits,
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({
    model: 'google/gemini-2.5-flash',
    decisionModel: false,
    embeddingModel: 'qwen/qwen3-embedding-8b',
    models: { model: 'google/gemini-2.5-flash', decisionModel: null, embeddingModel: 'qwen/qwen3-embedding-8b' },
    limits,
    updatedBy: 'Kaan',
  })

  const bad = await call('PUT', '/api/settings/ai', { limits: { ...limits, requestsPerHour: 1.5 } })
  expect(bad.status).toBe(400)
  expect((await bad.json()) as unknown).toEqual({
    error: 'requestsPerHour must be a whole number above 0 and at most 1000000, or null for no limit',
  })
})

test('models must exist on OpenRouter and be of the right kind', async () => {
  for (const [body, error] of [
    [{ model: 'openai/gpt-9' }, 'OpenRouter has no model "openai/gpt-9"'],
    [{ model: 'typesafe/jev-1.13' }, 'typesafe/jev-1.13 does not answer with text'],
    [{ decisionModel: 'google/gemini-2.5-flash' }, 'google/gemini-2.5-flash is not a decision model'],
    [{ embeddingModel: 'google/gemini-2.5-flash' }, 'google/gemini-2.5-flash is not an embedding model'],
    [{ visionModel: 'deepseek/deepseek-v4.1-flash' }, 'deepseek/deepseek-v4.1-flash does not read images'],
    [{ model: 'two words' }, '"two words" is not a model ID'],
  ] as const) {
    const res = await call('PUT', '/api/settings/ai', { ...body, limits: DEFAULT_LIMITS })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
  }
})

test('a project has its own models and limits, and shows its usage', async () => {
  const gateway = createAiGateway(host).interceptor('filament', { source: 'runtime' })!
  await gateway.handle(
    new Request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{"model":"openai/gpt-5-mini"}' }),
    async () => Response.json({ usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.25 } }),
  )

  const initial = await (await call('GET', '/api/projects/filament/ai')).json()
  expect(initial).toMatchObject({
    host: { models: ai.models, limits: DEFAULT_LIMITS },
    project: { model: null, decisionModel: null, limits: null },
    models: ai.models,
    limits: DEFAULT_LIMITS,
    usage: { lastMinute: 1, day: { requests: 1, promptTokens: 3, completionTokens: 4, cost: 0.25 } },
  })

  const limits = { ...DEFAULT_LIMITS, throttle: false }
  const saved = await (
    await call('PUT', '/api/projects/filament/ai', { model: 'google/gemini-2.5-flash', decisionModel: null, visionModel: 'google/gemini-2.5-flash', limits })
  ).json()
  expect(saved).toMatchObject({
    project: { model: 'google/gemini-2.5-flash', decisionModel: null, visionModel: 'google/gemini-2.5-flash', limits, updatedBy: 'Kaan' },
    models: { ...ai.models, model: 'google/gemini-2.5-flash', visionModel: 'google/gemini-2.5-flash' },
    limits,
  })

  const reset = await (await call('PUT', '/api/projects/filament/ai', { limits: null })).json()
  expect(reset).toMatchObject({ project: { model: null, limits: null, updatedBy: null }, models: ai.models, limits: DEFAULT_LIMITS })

  const everyProject = await (await call('GET', '/api/settings/ai')).json()
  expect(everyProject).toMatchObject({ usage: [{ project: 'filament', requests: 1, cost: 0.25 }] })

  expect((await call('GET', '/api/projects/nope/ai')).status).toBe(404)
})

test('agents cannot see or change the settings over the web API', async () => {
  const { token } = createAgentToken(host.db, 'claude')
  const agent = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const limits = { ...DEFAULT_LIMITS, throttle: false }
  expect((await call('GET', '/api/settings/ai', undefined, agent)).status).toBe(401)
  expect((await call('PUT', '/api/settings/ai', { limits }, agent)).status).toBe(401)
  expect((await call('PUT', '/api/projects/filament/ai', { limits }, agent)).status).toBe(401)
})

async function apiKey(res: Promise<Response>) {
  return ((await (await res).json()) as { apiKey: { secret: unknown; ownKey: string[] } }).apiKey
}

test('people set the OpenRouter API key for all hobs, stored as a secret', async () => {
  await app.close()
  const secrets = createSecretStore(host, randomBytes(32))
  app = await startTestApp(host, { ai, secrets })
  await createProject(host, 'alarms')
  secrets.create({ name: 'Alarms key', value: 'own', hosts: ['openrouter.ai'], assign: { project: 'alarms', envName: 'OPENROUTER_API_KEY' } }, { kind: 'host' })

  expect(await apiKey(call('GET', '/api/settings/ai'))).toEqual({ secret: null, ownKey: ['alarms'] })
  expect((await call('PUT', '/api/settings/ai/key', { value: '  ' })).status).toBe(400)

  const res = await call('PUT', '/api/settings/ai/key', { value: ' sk-or-1 ' })
  expect(res.status).toBe(200)
  expect(await apiKey(Promise.resolve(res))).toMatchObject({ secret: { name: 'OpenRouter API key', updatedBy: 'Kaan' }, ownKey: ['alarms'] })
  expect(secrets.forSandbox('filament')).toEqual({ OPENROUTER_API_KEY: { value: 'sk-or-1', hosts: ['openrouter.ai'], headers: [] } })
  expect(JSON.stringify(await (await call('GET', '/api/settings/ai')).json())).not.toContain('sk-or-1')

  await call('PUT', '/api/settings/ai/key', { value: 'sk-or-2' })
  expect(secrets.forSandbox('filament').OPENROUTER_API_KEY?.value).toBe('sk-or-2')
  expect(secrets.list()).toHaveLength(2)

  expect((await apiKey(call('DELETE', '/api/settings/ai/key'))).secret).toBeNull()
  expect(secrets.forSandbox('filament')).toEqual({})
  expect(secrets.forSandbox('alarms').OPENROUTER_API_KEY?.value).toBe('own')
})
