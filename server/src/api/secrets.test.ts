import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentToken, ensureAgent } from '../agents.ts'
import { registerClient } from '../oauth/clients.ts'
import { approveRequest, exchangeCode, getRequest, saveRequest } from '../oauth/grants.ts'
import { s256 } from '../oauth/secrets.ts'
import { createProject } from '../projects.ts'
import { queryLogs } from '../runtime/logs.ts'
import { createSecretStore, type HostRequest, type SecretInfo, type SecretStore } from '../secrets.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, TEST_PUBLIC_URL, writeHeaders } from '../test-web.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let secrets: SecretStore
let cookie: string
let userId: number

beforeEach(async () => {
  host = createTestHost()
  secrets = createSecretStore(host, randomBytes(32))
  app = await startTestApp(host, { secrets })
  const session = signedIn(host)
  cookie = session.cookie
  userId = session.user.id
  await createProject(host, 'filament')
  await createProject(host, 'alarms')
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = writeHeaders(cookie)) {
  return fetch(`${app.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

function oauthAccessToken(): string {
  const redirectUri = 'http://127.0.0.1/callback'
  const { client } = registerClient(host.db, { redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
  const verifier = randomBytes(32).toString('base64url')
  const now = Date.now()
  const id = saveRequest(
    host.db,
    { clientId: client.id, redirectUri, state: null, codeChallenge: s256(verifier), resource: `${TEST_PUBLIC_URL}/mcp`, scope: null },
    now,
  )
  const approved = approveRequest(host.db, { request: getRequest(host.db, id, now)!, client, agentName: 'Claude', userId, now })
  return exchangeCode(host.db, { client, code: approved!.code, redirectUri, verifier, resource: undefined, now }).access_token
}

test('users create, change, list and delete library secrets without ever getting values back', async () => {
  const created = await call('POST', '/api/secrets', { name: 'Spoolman API key', value: 'the-real-value', hosts: ['api.spools.example'] })
  expect(created.status).toBe(201)
  const createdBody = await created.text()
  expect(createdBody).not.toContain('the-real-value')
  const secret = JSON.parse(createdBody) as SecretInfo
  expect(secret).toMatchObject({ name: 'Spoolman API key', hosts: ['api.spools.example'], createdBy: 'Kaan', assignments: [] })

  const updated = await call('PATCH', `/api/secrets/${secret.id}`, { hosts: ['*.spools.example'] })
  expect(updated.status).toBe(200)
  expect(await updated.json()).toMatchObject({ hosts: ['*.spools.example'], updatedBy: 'Kaan' })
  expect((await call('PATCH', `/api/secrets/${secret.id}`, { value: 'rotated', name: 'Spoolman' })).status).toBe(200)

  const listed = await (await call('GET', '/api/secrets', undefined, { cookie })).text()
  expect(listed).not.toContain('the-real-value')
  expect(listed).not.toContain('rotated')
  expect(JSON.parse(listed)).toMatchObject([{ id: secret.id, name: 'Spoolman' }])

  expect((await call('DELETE', `/api/secrets/${secret.id}`)).status).toBe(204)
  expect((await call('DELETE', `/api/secrets/${secret.id}`)).status).toBe(404)
  expect(secrets.list()).toEqual([])
})

test('users assign and unassign secrets, or create and assign in one step', async () => {
  const created = await call('POST', '/api/secrets', {
    name: 'Spoolman API key',
    value: 'v',
    hosts: ['api.spools.example'],
    assign: { project: 'filament', envName: 'SPOOLMAN_TOKEN' },
  })
  expect(created.status).toBe(201)
  const { id } = (await created.json()) as SecretInfo

  const assigned = await call('PUT', '/api/projects/alarms/secrets/API_KEY', { secretId: id })
  expect(assigned.status).toBe(201)
  expect(await assigned.json()).toMatchObject({
    envName: 'API_KEY',
    secretId: id,
    secret: 'Spoolman API key',
    hosts: ['api.spools.example'],
    assignedBy: { kind: 'user', name: 'Kaan' },
  })
  expect(await (await call('GET', '/api/projects/filament/secrets', undefined, { cookie })).json()).toMatchObject([
    { envName: 'SPOOLMAN_TOKEN', secret: 'Spoolman API key' },
  ])
  expect(secrets.forSandbox('alarms')).toEqual({ API_KEY: { value: 'v', hosts: ['api.spools.example'] } })

  expect((await call('PUT', '/api/projects/alarms/secrets/OTHER', { secretId: id })).status).toBe(409)
  expect((await call('DELETE', '/api/projects/alarms/secrets/API_KEY')).status).toBe(204)
  expect((await call('DELETE', '/api/projects/alarms/secrets/API_KEY')).status).toBe(404)
  expect(secrets.forSandbox('alarms')).toEqual({})
  expect(queryLogs(host, { project: 'alarms', eventsOnly: true, limit: 10 }).map((l) => l.message)).toEqual([
    'Kaan added the secret "Spoolman API key" as API_KEY. It is only sent to api.spools.example',
    'Kaan removed the secret "Spoolman API key" (API_KEY)',
  ])
})

test('invalid secrets, clashes and unknown projects are refused', async () => {
  const bad = await call('PUT', '/api/projects/filament/secrets/lower', { secretId: 1 })
  expect(bad.status).toBe(404)
  const { id } = secrets.create({ name: 'Key', value: 'x', hosts: ['a.example'] }, { kind: 'host' })
  const lower = await call('PUT', '/api/projects/filament/secrets/lower', { secretId: id })
  expect(lower.status).toBe(400)
  expect(await lower.json()).toEqual({ error: expect.stringContaining('capital letters') })
  expect((await call('POST', '/api/secrets', { name: 'New', hosts: ['a.example'] })).status).toBe(400)
  expect((await call('POST', '/api/secrets', { name: 'New', value: 1, hosts: ['a.example'] })).status).toBe(400)
  expect((await call('POST', '/api/secrets', { name: 'key', value: 'x', hosts: ['a.example'] })).status).toBe(409)
  const nowhere = { name: 'New', value: 'x', hosts: ['a.example'], assign: { project: 'nope', envName: 'NEW' } }
  expect((await call('POST', '/api/secrets', nowhere)).status).toBe(404)
  expect((await call('PUT', '/api/projects/nope/secrets/KEY', { secretId: id })).status).toBe(404)
  expect((await call('PUT', '/api/projects/filament/secrets/KEY', { value: 'x', hosts: ['a.example'] })).status).toBe(400)
  expect(secrets.list().map((s) => s.name)).toEqual(['Key'])
})

test('agent and OAuth tokens get nothing from any secret endpoint, and writes need CSRF protection', async () => {
  const { id } = secrets.create({ name: 'Key', value: 'the-value', hosts: ['a.example'] }, { kind: 'host' })
  const agent = { kind: 'agent' as const, id: ensureAgent(host.db, 'claude').id, name: 'claude' }
  const request = secrets.requestHosts('Key', ['evil.example'], 'Because', agent)
  const tokens = [createAgentToken(host.db, 'claude').token, oauthAccessToken()]
  const endpoints: [string, string, unknown?][] = [
    ['GET', '/api/secrets'],
    ['POST', '/api/secrets', { name: 'Mine', value: 'x', hosts: ['evil.example'], assign: { project: 'filament', envName: 'X' } }],
    ['PATCH', `/api/secrets/${id}`, { hosts: ['evil.example'] }],
    ['PATCH', `/api/secrets/${id}`, { value: 'x' }],
    ['DELETE', `/api/secrets/${id}`],
    ['GET', '/api/projects/filament/secrets'],
    ['PUT', '/api/projects/filament/secrets/KEY', { secretId: id }],
    ['DELETE', '/api/projects/filament/secrets/KEY'],
    ['GET', `/api/secrets/host-requests/${request.id}`],
    ['POST', `/api/secrets/host-requests/${request.id}/approve`],
    ['POST', `/api/secrets/host-requests/${request.id}/deny`],
  ]
  for (const token of tokens) {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-hobwork-csrf': '1' }
    for (const [method, path, body] of endpoints) {
      const res = await call(method, path, body, headers)
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(await res.text()).not.toContain('the-value')
    }
  }
  const noCsrf = { cookie, 'content-type': 'application/json' }
  const foreign = { ...writeHeaders(cookie), origin: 'https://evil.example.com' }
  for (const headers of [noCsrf, foreign]) {
    for (const [method, path, body] of endpoints.filter(([method]) => method !== 'GET')) {
      expect((await call(method, path, body, headers)).status, `${method} ${path}`).toBe(403)
    }
  }
  expect(secrets.list()).toMatchObject([{ id, name: 'Key', hosts: ['a.example'], assignments: [] }])
  expect(secrets.forSandbox('filament')).toEqual({})
})

test('people approve or deny the hosts an agent asked for', async () => {
  const agent = { kind: 'agent' as const, id: ensureAgent(host.db, 'claude').id, name: 'claude' }
  const created = await call('POST', '/api/secrets', { name: 'Spools', value: 'v', assign: { project: 'filament', envName: 'SPOOLS' } })
  expect(created.status).toBe(201)
  expect(await created.json()).toMatchObject({ hosts: [], pendingHostRequest: null })
  expect(secrets.forSandbox('filament')).toEqual({ SPOOLS: { value: 'v', hosts: [] } })

  const first = secrets.requestHosts('Spools', ['old.example'], 'First try', agent)
  const request = secrets.requestHosts('Spools', ['API.Spools.example', '*.cdn.example'], 'Spoolman lives there', agent)
  expect(((await (await call('GET', `/api/secrets/host-requests/${first.id}`)).json()) as HostRequest).decision).toBe('superseded')
  expect((await call('POST', `/api/secrets/host-requests/${first.id}/approve`)).status).toBe(409)

  const [listed] = (await (await call('GET', '/api/secrets')).json()) as SecretInfo[]
  expect(listed?.pendingHostRequest).toEqual({ id: request.id, hosts: ['api.spools.example', '*.cdn.example'], agent: 'claude' })
  expect(await (await call('GET', `/api/secrets/host-requests/${request.id}`)).json()).toMatchObject({
    secret: { name: 'Spools', hosts: [] },
    agent: 'claude',
    hosts: ['api.spools.example', '*.cdn.example'],
    reason: 'Spoolman lives there',
    decision: null,
  })

  const approved = await call('POST', `/api/secrets/host-requests/${request.id}/approve`)
  expect(await approved.json()).toMatchObject({ decision: 'approved', decidedBy: expect.any(String) })
  expect(secrets.forSandbox('filament')).toEqual({ SPOOLS: { value: 'v', hosts: ['api.spools.example', '*.cdn.example'] } })
  expect((await call('POST', `/api/secrets/host-requests/${request.id}/deny`)).status).toBe(409)

  const denied = secrets.requestHosts('Spools', ['evil.example'], 'Trust me', agent)
  expect(((await (await call('POST', `/api/secrets/host-requests/${denied.id}/deny`)).json()) as HostRequest).decision).toBe('denied')
  expect(secrets.get('Spools')).toMatchObject({ hosts: ['api.spools.example', '*.cdn.example'], pendingHostRequest: null })
  expect((await call('GET', '/api/secrets/host-requests/999')).status).toBe(404)
})
