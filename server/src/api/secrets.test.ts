import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createProject } from '../projects.ts'
import { createSecretStore, type SecretStore } from '../secrets.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let secrets: SecretStore
let cookie: string

beforeEach(async () => {
  host = createTestHost()
  secrets = createSecretStore(host, randomBytes(32))
  app = await startTestApp(host, { secrets })
  cookie = signedIn(host).cookie
  await createProject(host, 'filament')
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = writeHeaders(cookie)) {
  return fetch(`${app.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

test('users create, update, list and delete project secrets without ever getting values back', async () => {
  const created = await call('PUT', '/api/projects/filament/secrets/SPOOL_API_KEY', {
    value: 'the-real-value',
    hosts: ['api.spools.example'],
  })
  expect(created.status).toBe(201)
  const createdBody = await created.text()
  expect(createdBody).not.toContain('the-real-value')
  expect(JSON.parse(createdBody)).toMatchObject({ name: 'SPOOL_API_KEY', scope: 'project', hosts: ['api.spools.example'] })

  const updated = await call('PUT', '/api/projects/filament/secrets/SPOOL_API_KEY', { hosts: ['*.spools.example'] })
  expect(updated.status).toBe(200)
  expect(secrets.forSandbox('filament').SPOOL_API_KEY).toEqual({ value: 'the-real-value', hosts: ['*.spools.example'] })

  expect((await call('PUT', '/api/secrets/SHARED', { value: 'shared-value', hosts: ['shared.example'] })).status).toBe(201)
  const list = await call('GET', '/api/projects/filament/secrets', undefined, { cookie })
  const listed = await list.text()
  expect(listed).not.toContain('the-real-value')
  expect(listed).not.toContain('shared-value')
  expect(JSON.parse(listed).map((s: { name: string; scope: string }) => [s.name, s.scope])).toEqual([
    ['SHARED', 'global'],
    ['SPOOL_API_KEY', 'project'],
  ])
  expect(await (await call('GET', '/api/secrets', undefined, { cookie })).json()).toMatchObject([{ name: 'SHARED' }])

  expect((await call('DELETE', '/api/projects/filament/secrets/SPOOL_API_KEY')).status).toBe(204)
  expect((await call('DELETE', '/api/projects/filament/secrets/SPOOL_API_KEY')).status).toBe(404)
  expect((await call('DELETE', '/api/secrets/SHARED')).status).toBe(204)
  expect(secrets.effective('filament')).toEqual([])
})

test('invalid secrets and unknown projects are refused', async () => {
  const bad = await call('PUT', '/api/projects/filament/secrets/lower', { value: 'x', hosts: ['a.example'] })
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: expect.stringContaining('capital letters') })
  expect((await call('PUT', '/api/projects/filament/secrets/NEW', { value: 'x' })).status).toBe(400)
  expect((await call('PUT', '/api/projects/filament/secrets/NEW', { value: 1, hosts: ['a.example'] })).status).toBe(400)
  expect((await call('PUT', '/api/projects/nope/secrets/NEW', { value: 'x', hosts: ['a.example'] })).status).toBe(404)
})

test('agents cannot manage or list secrets through the API, and writes need CSRF protection', async () => {
  const { token } = createAgentToken(host.db, 'claude')
  const agent = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const body = { value: 'x', hosts: ['a.example'] }
  expect((await call('PUT', '/api/projects/filament/secrets/TOKEN', body, agent)).status).toBe(401)
  expect((await call('PUT', '/api/secrets/TOKEN', body, agent)).status).toBe(401)
  expect((await call('GET', '/api/projects/filament/secrets', undefined, agent)).status).toBe(401)
  expect((await call('PUT', '/api/secrets/TOKEN', body, { cookie, 'content-type': 'application/json' })).status).toBe(403)
  const foreign = { ...writeHeaders(cookie), origin: 'https://evil.example.com' }
  expect((await call('DELETE', '/api/secrets/TOKEN', undefined, foreign)).status).toBe(403)
  expect(secrets.list()).toEqual([])
})
