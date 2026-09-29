import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createAiGateway } from '../ai/gateway.ts'
import { DEFAULT_LIMITS } from '../ai/settings.ts'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string

beforeEach(async () => {
  host = createTestHost()
  cookie = signedIn(host).cookie
  await createProject(host, 'filament')
  app = await startTestApp(host)
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = writeHeaders(cookie)) {
  return fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

test('host-wide settings start with the defaults and are saved by people', async () => {
  const initial = await (await call('GET', '/api/settings/ai')).json()
  expect(initial).toMatchObject({ models: null, limits: DEFAULT_LIMITS, defaults: DEFAULT_LIMITS, updatedBy: null, usage: [] })

  const limits = { ...DEFAULT_LIMITS, requestsPerMinute: 5, costPerMonth: null }
  const res = await call('PUT', '/api/settings/ai', { models: [' openai/* ', 'openai/*', 'google/gemini-2.5-flash'], limits })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ models: ['openai/*', 'google/gemini-2.5-flash'], limits, updatedBy: 'Kaan' })

  const bad = await call('PUT', '/api/settings/ai', { models: null, limits: { ...limits, requestsPerHour: 1.5 } })
  expect(bad.status).toBe(400)
  expect((await bad.json()) as unknown).toEqual({
    error: 'requestsPerHour must be a whole number above 0 and at most 1000000, or null for no limit',
  })
})

test('a project narrows the models and has its own limits, and shows its usage', async () => {
  const gateway = createAiGateway(host).interceptor('filament', { source: 'runtime' })!
  await gateway.handle(
    new Request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{"model":"openai/gpt-5-mini"}' }),
    async () => Response.json({ usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.25 } }),
  )

  const initial = await (await call('GET', '/api/projects/filament/ai')).json()
  expect(initial).toMatchObject({
    host: { models: null, limits: DEFAULT_LIMITS },
    project: { models: null, limits: null },
    limits: DEFAULT_LIMITS,
    usage: { lastMinute: 1, day: { requests: 1, promptTokens: 3, completionTokens: 4, cost: 0.25 } },
  })

  const limits = { ...DEFAULT_LIMITS, throttle: false }
  const saved = await (await call('PUT', '/api/projects/filament/ai', { models: [], limits })).json()
  expect(saved).toMatchObject({ project: { models: [], limits, updatedBy: 'Kaan' }, limits })

  const reset = await (await call('PUT', '/api/projects/filament/ai', { models: null, limits: null })).json()
  expect(reset).toMatchObject({ project: { models: null, limits: null, updatedBy: null }, limits: DEFAULT_LIMITS })

  const everyProject = await (await call('GET', '/api/settings/ai')).json()
  expect(everyProject).toMatchObject({ usage: [{ project: 'filament', requests: 1, cost: 0.25 }] })

  expect((await call('GET', '/api/projects/nope/ai')).status).toBe(404)
})

test('agents cannot see or change the settings over the web API', async () => {
  const { token } = createAgentToken(host.db, 'claude')
  const agent = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const limits = { ...DEFAULT_LIMITS, throttle: false }
  expect((await call('GET', '/api/settings/ai', undefined, agent)).status).toBe(401)
  expect((await call('PUT', '/api/settings/ai', { models: null, limits }, agent)).status).toBe(401)
  expect((await call('PUT', '/api/projects/filament/ai', { models: null, limits }, agent)).status).toBe(401)
})
