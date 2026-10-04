import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { verifyAgentToken } from '../agents.ts'
import { createDelivery, type Deployment } from '../delivery.ts'
import { git } from '../git.ts'
import { repoPath } from '../host.ts'
import { createProject, DEFAULT_BRANCH } from '../projects.ts'
import { generateEd25519KeyPair } from '../ssh/keys.ts'
import { createTestHost } from '../test-host.ts'
import { seedMain } from '../test-project.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'
import { recordVersion } from '../versions.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from '../workspaces.ts'

vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let deployments: Deployment[]
let cookie: string

beforeEach(async () => {
  host = createTestHost()
  deployments = []
  const delivery = createDelivery(host, {
    workspaces: createWorkspaceManager<ExecWorkspaceVm>(host),
    deploy: async (deployment) => {
      deployments.push(deployment)
    },
  })
  app = await startTestApp(host, { delivery })
  cookie = signedIn(host).cookie
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

const jsonOf = (res: Response): Promise<any> => res.json()

function get(path: string, headers: Record<string, string> = { cookie }) {
  return fetch(`${app.base}${path}`, { headers })
}

function post(path: string, body?: unknown, headers: Record<string, string> = writeHeaders(cookie)) {
  return fetch(`${app.base}${path}`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function projectWithTwoVersions() {
  const project = await createProject(host, 'filament')
  const commit = await seedMain(host, 'filament')
  recordVersion(host, { projectId: project.id, commit, summary: 'Track spools' })
}

test('every API route needs a signed-in user', async () => {
  const paths = ['/api/projects', '/api/projects/filament', '/api/agents']
  for (const path of paths) expect((await get(path, {})).status).toBe(401)
  expect((await post('/api/agents', { name: 'x' }, { 'x-hobwork-csrf': '1' })).status).toBe(401)
  expect((await post('/api/projects/filament/versions/1/restore', undefined, { 'x-hobwork-csrf': '1' })).status).toBe(401)
  expect((await post('/api/tokens/1/revoke', undefined, { 'x-hobwork-csrf': '1' })).status).toBe(401)
  expect((await get('/api/projects', { cookie: 'hobwork_session=forged' })).status).toBe(401)
})

test('state-changing API calls need the CSRF header and a same-origin request', async () => {
  expect((await post('/api/agents', { name: 'x' }, { cookie, 'content-type': 'application/json' })).status).toBe(403)
  const foreign = { ...writeHeaders(cookie), origin: 'https://evil.example.com' }
  expect((await post('/api/agents', { name: 'x' }, foreign)).status).toBe(403)
  expect((await post('/api/agents', { name: 'x' })).status).toBe(201)
})

test('wrong method and unknown API paths', async () => {
  expect((await fetch(`${app.base}/api/projects`, { method: 'DELETE', headers: { cookie } })).status).toBe(405)
  expect((await get('/api/nope')).status).toBe(404)
})

test('projects overview shows status and the current version', async () => {
  expect(await jsonOf(await get('/api/projects'))).toEqual([])
  await projectWithTwoVersions()
  expect(await jsonOf(await get('/api/projects'))).toEqual([
    {
      name: 'filament',
      defaultBranch: 'main',
      status: 'ready',
      currentVersion: expect.objectContaining({ number: 2, summary: 'Track spools', by: null, restoredFrom: null }),
      iconUrl: '/api/projects/filament/icon',
    },
  ])
})

test('a project without a rendered icon gets its first letter', async () => {
  await projectWithTwoVersions()
  const res = await get('/api/projects/filament/icon')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/svg+xml')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await res.text()).toContain('>F</text>')
  expect((await get('/api/projects/nope/icon')).status).toBe(404)
})

test('project detail shows the hob', async () => {
  await projectWithTwoVersions()
  const body = await jsonOf(await get('/api/projects/filament'))
  expect(body).toMatchObject({ name: 'filament', status: 'ready', currentVersion: 2 })
  expect((await get('/api/projects/nope')).status).toBe(404)
})

test('versions are listed newest first, a page at a time', async () => {
  await projectWithTwoVersions()
  const numbers = (body: { versions: { number: number }[] }) => body.versions.map((v) => v.number)
  const all = await jsonOf(await get('/api/projects/filament/versions'))
  expect(numbers(all)).toEqual([2, 1])
  expect(all.more).toBe(false)
  const first = await jsonOf(await get('/api/projects/filament/versions?limit=1'))
  expect(numbers(first)).toEqual([2])
  expect(first.more).toBe(true)
  const rest = await jsonOf(await get('/api/projects/filament/versions?limit=1&before=2'))
  expect(numbers(rest)).toEqual([1])
  expect(rest.more).toBe(false)
  expect((await get('/api/projects/filament/versions?before=x')).status).toBe(400)
  expect((await get('/api/projects/nope/versions')).status).toBe(404)
})

test('restoring a version commits it on main as the signed-in user', async () => {
  await projectWithTwoVersions()
  const res = await post('/api/projects/filament/versions/1/restore')
  expect(res.status).toBe(200)
  expect(await jsonOf(res)).toEqual({
    version: expect.objectContaining({ number: 3, summary: 'Restore version 1', by: 'Kaan', restoredFrom: 1 }),
  })
  expect(deployments).toEqual([expect.objectContaining({ project: 'filament', version: 3, reason: 'restore' })])
  const author = await git(['--git-dir', repoPath(host, 'filament'), 'log', '-1', '--format=%an <%ae>', DEFAULT_BRANCH])
  expect(author.trim()).toBe('Kaan <kaan@example.com>')

  const again = await post('/api/projects/filament/versions/3/restore')
  expect(again.status).toBe(409)
  expect((await jsonOf(again)).error).toContain('already has the code of version 3')
  expect((await post('/api/projects/filament/versions/9/restore')).status).toBe(409)
  expect((await post('/api/projects/nope/versions/1/restore')).status).toBe(404)
})

test('creating an agent shows its key once and the key works for MCP', async () => {
  const res = await post('/api/agents', { name: '  claude-code ' })
  expect(res.status).toBe(201)
  const { agent, token } = await jsonOf(res)
  expect(agent.name).toBe('claude-code')
  expect(verifyAgentToken(host.db, token)).toMatchObject(agent)

  const [listed] = await jsonOf(await get('/api/agents'))
  expect(listed).toMatchObject({ id: agent.id, name: 'claude-code', tokens: [{ revokedAt: null }] })
  expect(JSON.stringify(listed)).not.toContain(token)

  expect((await post('/api/agents', { name: 'claude-code' })).status).toBe(409)
  expect((await post('/api/agents', { name: ' ' })).status).toBe(400)
  expect((await post('/api/agents', { name: 'x'.repeat(65) })).status).toBe(400)
})

test('adding a key to an agent and revoking keys', async () => {
  const { agent, token: first } = await jsonOf(await post('/api/agents', { name: 'cowork' }))
  const res = await post(`/api/agents/${agent.id}/tokens`)
  expect(res.status).toBe(201)
  const { token: second } = await jsonOf(res)
  expect(verifyAgentToken(host.db, second)).toMatchObject(agent)

  const [listed] = await jsonOf(await get('/api/agents'))
  expect(listed.tokens).toHaveLength(2)
  const firstId = listed.tokens.at(-1).id
  expect((await post(`/api/tokens/${firstId}/revoke`)).status).toBe(204)
  expect(verifyAgentToken(host.db, first)).toBeUndefined()
  expect(verifyAgentToken(host.db, second)).toMatchObject(agent)
  expect((await post(`/api/tokens/${firstId}/revoke`)).status).toBe(404)
  expect((await post('/api/agents/999/tokens')).status).toBe(404)
})

test('keys can be limited to reading and to some projects', async () => {
  host.db.prepare("INSERT INTO projects (name) VALUES ('filament'), ('garden')").run()
  const created = await post('/api/agents', { name: 'reader', access: { readOnly: true, projects: ['garden'] } })
  expect(created.status).toBe(201)
  const { agent, token } = await jsonOf(created)
  expect(verifyAgentToken(host.db, token)?.access).toEqual({ readOnly: true, projects: ['garden'] })
  const second = await jsonOf(await post(`/api/agents/${agent.id}/tokens`, { access: { readOnly: false, projects: ['filament', 'garden'] } }))
  expect(verifyAgentToken(host.db, second.token)?.access).toEqual({ readOnly: false, projects: ['filament', 'garden'] })

  const [listed] = await jsonOf(await get('/api/agents'))
  expect(listed.tokens.map((t: { access: unknown }) => t.access)).toEqual([
    { readOnly: false, projects: ['filament', 'garden'] },
    { readOnly: true, projects: ['garden'] },
  ])
  const bad = await post(`/api/agents/${agent.id}/tokens`, { access: { readOnly: 'yes' } })
  expect(bad.status).toBe(400)
  expect((await jsonOf(bad)).error).toBe('readOnly must be true or false')
  expect((await post('/api/agents', { name: 'other', access: { projects: ['nope'] } })).status).toBe(400)
})

test('registering and revoking SSH keys of an agent', async () => {
  const { agent } = await jsonOf(await post('/api/agents', { name: 'laptop' }))
  const { public: publicKey, private: privateKey } = generateEd25519KeyPair()
  const add = (body: Record<string, unknown>) => post(`/api/agents/${agent.id}/ssh-keys`, body)
  const unauthenticated = await post(`/api/agents/${agent.id}/ssh-keys`, { name: 'Laptop', publicKey }, { 'x-hobwork-csrf': '1' })
  expect(unauthenticated.status).toBe(401)
  const noCsrf = await post(`/api/agents/${agent.id}/ssh-keys`, { name: 'Laptop', publicKey }, { cookie, 'content-type': 'application/json' })
  expect(noCsrf.status).toBe(403)
  expect((await jsonOf(await add({ publicKey }))).error).toBe('Give the SSH key a name')
  expect((await add({ name: 'x'.repeat(65), publicKey })).status).toBe(400)

  const res = await add({ name: ' Laptop ', publicKey: `${publicKey} kaan@laptop\n` })
  expect(res.status).toBe(201)
  const key = await jsonOf(res)
  expect(key).toMatchObject({
    agentId: agent.id,
    name: 'Laptop',
    algorithm: 'ssh-ed25519',
    comment: 'kaan@laptop',
    addedFrom: { via: 'web', userName: expect.any(String) },
    lastUsedAt: null,
    revokedAt: null,
  })
  expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  const [listed] = await jsonOf(await get('/api/agents'))
  expect(listed.sshKeys).toEqual([key])

  expect((await jsonOf(await add({ name: 'Again', publicKey }))).error).toContain('already registered to laptop')
  expect((await jsonOf(await add({ name: 'Private', publicKey: privateKey }))).error).toContain('private key')
  expect((await add({ name: 'Bad', publicKey: 'ssh-ed25519 nope' })).status).toBe(400)
  expect((await post('/api/agents/999/ssh-keys', { name: 'Laptop', publicKey })).status).toBe(404)

  expect((await post(`/api/ssh-keys/${key.id}/revoke`)).status).toBe(204)
  expect((await post(`/api/ssh-keys/${key.id}/revoke`)).status).toBe(404)
  const [after] = (await jsonOf(await get('/api/agents')))[0].sshKeys
  expect(after.revokedAt).not.toBeNull()
  expect((await add({ name: 'Laptop', publicKey })).status).toBe(201)
})

test('request bodies must be JSON', async () => {
  const headers = { ...writeHeaders(cookie), 'content-type': 'text/plain' }
  expect((await fetch(`${app.base}/api/agents`, { method: 'POST', headers, body: 'name=x' })).status).toBe(415)
  const bad = await fetch(`${app.base}/api/agents`, { method: 'POST', headers: writeHeaders(cookie), body: '{' })
  expect(bad.status).toBe(400)
})
