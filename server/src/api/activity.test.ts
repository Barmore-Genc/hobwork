import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createProjectData, type ProjectData } from '../data/project-data.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject } from '../projects.ts'
import { appendLog, finishInvocation, startInvocation, type InvocationKind } from '../runtime/logs.ts'
import { createRuntime, type Runtime } from '../runtime/runtime.ts'
import { verifyWebhookToken } from '../runtime/webhooks.ts'
import { createSecretStore, type SecretStore } from '../secrets.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain, type Files } from '../test-project.ts'
import { signedIn, startTestApp, TEST_PUBLIC_URL, writeHeaders } from '../test-web.ts'
import { recordVersion } from '../versions.ts'

vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let runtime: Runtime
let data: ProjectData
let cookie: string
let secrets: SecretStore

const HOBWORK_JSON = {
  routes: { 'GET /spools': { handler: 'src/spools.ts' } },
  crons: { weigh: { schedule: '30 7 * * *', handler: 'src/weigh.ts' } },
  webhooks: { scanned: { handler: 'src/scanned.ts' } },
  triggers: {
    'desk-button': {
      homeassistant: { trigger: 'state', entity_id: 'input_button.desk' },
      handler: 'src/desk.ts',
    },
  },
  egress: ['api.spools.example'],
}

// Stands in for `vite build`: a UI page, a hashed asset, a public file and a handler bundle.
const BUILD = [
  'mkdir -p dist/assets dist/handlers/src',
  `printf '<!doctype html><html><head><title>Spools</title></head><body>spools</body></html>' > dist/index.html`,
  `printf 'console.log(1)' > dist/assets/index-abc123.js`,
  `printf '<svg/>' > dist/favicon.svg`,
  `printf 'export default () => 1' > dist/handlers/src/spools.js`,
].join(' && ')

async function release(files: Files, summary = 'Track spools') {
  const commit = await seedMain(host, 'filament', files)
  const { id } = host.db.prepare('SELECT id FROM projects WHERE name = ?').get('filament') as { id: number }
  return recordVersion(host, { projectId: id, commit, summary })
}

function projectFiles(build = BUILD): Files {
  return { 'package.json': fakePackageJson({ build }), 'hobwork.json': JSON.stringify(HOBWORK_JSON) }
}

beforeEach(async () => {
  host = createTestHost()
  secrets = createSecretStore(host, randomBytes(32))
  data = createProjectData(host)
  runtime = createRuntime(host, { startBuildVm: startHostPipelineVm, data, secrets })
  app = await startTestApp(host, { runtime, data, secrets })
  cookie = signedIn(host).cookie
  await createProject(host, 'filament')
  await createProject(host, 'sleep')
})

afterEach(async () => {
  await app.close()
  await runtime.stop()
  await data.stop()
  host.dispose()
})

function get(path: string, headers: Record<string, string> = { cookie }) {
  return fetch(`${app.base}${path}`, { headers, redirect: 'manual' })
}

function invocation(kind: InvocationKind, name: string, result: 'ok' | 'error', project = 'filament') {
  const id = startInvocation(host, { project, version: 2, kind, name, manual: false })
  appendLog(host, { project, invocationId: id, source: 'handler', level: 'info', message: `running ${name}` })
  finishInvocation(host, id, {
    status: result,
    durationMs: 12,
    ...(result === 'error' ? { error: 'Error: scale offline', stack: 'Error: scale offline\n    at weigh (weigh.js:3:9)' } : {}),
  })
  return id
}

test('activity, log and webhook APIs need a signed-in user', async () => {
  await release(projectFiles())
  const { token } = createAgentToken(host.db, 'claude')
  const agent = { authorization: `Bearer ${token}` }
  const id = invocation('cron', 'weigh', 'ok')
  for (const path of ['/api/projects/filament/invocations', `/api/projects/filament/invocations/${id}`, '/api/projects/filament/logs']) {
    expect((await get(path, {})).status).toBe(401)
    expect((await get(path, agent)).status).toBe(401)
    expect((await get(path)).status).toBe(200)
  }
  const rotate = (headers: Record<string, string>) =>
    fetch(`${app.base}/api/projects/filament/webhooks/scanned/token`, { method: 'POST', headers })
  expect((await rotate({ ...agent, 'x-hobwork-csrf': '1' })).status).toBe(401)
  expect((await rotate({ cookie })).status).toBe(403)
  expect((await rotate(writeHeaders(cookie))).status).toBe(200)
})

test('invocations are listed newest first with filters and pages', async () => {
  await release(projectFiles())
  const first = invocation('cron', 'weigh', 'ok')
  const failed = invocation('cron', 'weigh', 'error')
  const route = invocation('route', 'GET /spools', 'ok')
  invocation('cron', 'bedtime', 'ok', 'sleep')

  const list = async (query: string) => (await (await get(`/api/projects/filament/invocations${query}`)).json()) as any
  const all = await list('')
  expect(all.invocations.map((i: { id: number }) => i.id)).toEqual([route, failed, first])
  expect(all.more).toBe(false)
  expect(all.invocations[1]).toMatchObject({ kind: 'cron', name: 'weigh', status: 'error', error: 'Error: scale offline', durationMs: 12 })
  expect(all.invocations[1]).not.toHaveProperty('stack')

  expect((await list('?kind=cron')).invocations.map((i: { id: number }) => i.id)).toEqual([failed, first])
  expect((await list('?status=error')).invocations.map((i: { id: number }) => i.id)).toEqual([failed])
  const page = await list('?limit=2')
  expect(page.invocations).toHaveLength(2)
  expect(page.more).toBe(true)
  expect((await list(`?before=${failed}`)).invocations.map((i: { id: number }) => i.id)).toEqual([first])
  expect((await list(`?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).invocations).toEqual([])
  expect((await list(`?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).invocations).toHaveLength(3)

  expect((await get('/api/projects/filament/invocations?kind=nope')).status).toBe(400)
  expect((await get('/api/projects/filament/invocations?since=yesterday-ish')).status).toBe(400)
  expect((await get('/api/projects/filament/invocations?before=-1')).status).toBe(400)
  expect((await get('/api/projects/nope/invocations')).status).toBe(404)
})

test('an invocation shows its error, stack trace and log lines', async () => {
  const failed = invocation('cron', 'weigh', 'error')
  const other = invocation('cron', 'bedtime', 'ok', 'sleep')
  const res = await get(`/api/projects/filament/invocations/${failed}`)
  expect(await res.json()).toMatchObject({
    id: failed,
    status: 'error',
    error: 'Error: scale offline',
    stack: expect.stringContaining('at weigh (weigh.js:3:9)'),
    logs: [{ invocationId: failed, message: 'running weigh', source: 'handler' }],
  })
  expect((await get(`/api/projects/filament/invocations/${other}`)).status).toBe(404)
  expect((await get('/api/projects/filament/invocations/999')).status).toBe(404)
})

test('the project log filters events and problems and continues after a cursor', async () => {
  appendLog(host, { project: 'filament', source: 'runtime', level: 'info', event: 'deploy', message: 'Deploying version 2' })
  appendLog(host, { project: 'filament', source: 'handler', level: 'info', message: 'weighed 812 g' })
  appendLog(host, { project: 'filament', source: 'runtime', level: 'warn', event: 'egress-blocked', message: 'Blocked evil.example:443' })
  appendLog(host, { project: 'sleep', source: 'handler', level: 'error', message: 'other project' })

  const logs = async (query: string) => (await (await get(`/api/projects/filament/logs${query}`)).json()) as any
  const messages = (body: { lines: { message: string }[] }) => body.lines.map((l) => l.message)
  const all = await logs('')
  expect(messages(all)).toEqual(['Deploying version 2', 'weighed 812 g', 'Blocked evil.example:443'])
  expect(messages(await logs('?view=events'))).toEqual(['Deploying version 2', 'Blocked evil.example:443'])
  expect(messages(await logs('?view=problems'))).toEqual(['Blocked evil.example:443'])
  expect(messages(await logs('?limit=1'))).toEqual(['Blocked evil.example:443'])

  const after = await logs(`?after=${all.cursor}`)
  expect(after).toEqual({ lines: [], cursor: all.cursor })
  appendLog(host, { project: 'filament', source: 'handler', level: 'info', message: 'weighed 790 g' })
  const next = await logs(`?after=${all.cursor}`)
  expect(messages(next)).toEqual(['weighed 790 g'])
  // Lines the view hides still move the cursor on.
  expect(await logs(`?after=${all.cursor}&view=events`)).toEqual({ lines: [], cursor: next.cursor })
  expect((await get('/api/projects/filament/logs?view=nope')).status).toBe(400)
})

test('the project page shows entry points, reachable hosts, the DB and the app', async () => {
  secrets.create(
    { name: 'Spools', value: 'x', hosts: ['auth.spools.example'], assign: { project: 'filament', envName: 'SPOOL_KEY' } },
    { kind: 'host' },
  )
  await release(projectFiles())
  const failed = invocation('cron', 'weigh', 'error')
  const body = (await (await get('/api/projects/filament')).json()) as any
  expect(body.entryPoints).toEqual({
    routes: [{ key: 'GET /spools', lastRun: null }],
    crons: [
      {
        name: 'weigh',
        schedule: '30 7 * * *',
        nextRun: expect.any(String),
        lastRun: { id: failed, status: 'error', startedAt: expect.any(String) },
      },
    ],
    webhooks: [{ name: 'scanned', tokenCreatedAt: null, lastRun: null }],
    triggers: [
      { name: 'desk-button', homeassistant: { trigger: 'state', entity_id: 'input_button.desk' }, device: null, lastRun: null },
    ],
  })
  const next = new Date(body.entryPoints.crons[0].nextRun)
  expect([next.getHours(), next.getMinutes()]).toEqual([7, 30])
  expect(body.egress).toEqual(['api.spools.example', 'auth.spools.example'])
  expect(body.database).toMatchObject({ sizeBytes: expect.any(Number), slowQueries: { count: 0 } })
  // Not built yet: it is built when opened.
  expect(body.app).toBe(true)
  await runtime.build('filament')
  expect(((await (await get('/api/projects/filament')).json()) as any).app).toBe(true)
})

test('a project without a UI build has no app', async () => {
  await release(projectFiles('mkdir -p dist/handlers'))
  await runtime.build('filament')
  expect(((await (await get('/api/projects/filament')).json()) as any).app).toBe(false)
})

test('rotating a webhook token shows its URL once', async () => {
  await release(projectFiles())
  const rotate = (name: string) =>
    fetch(`${app.base}/api/projects/filament/webhooks/${name}/token`, { method: 'POST', headers: writeHeaders(cookie) })
  const res = await rotate('scanned')
  const { url } = (await res.json()) as { url: string }
  expect(url).toMatch(new RegExp(`^${TEST_PUBLIC_URL}/hooks/filament/scanned/[A-Za-z0-9_-]{43}$`))
  expect(verifyWebhookToken(host, 'filament', 'scanned', url.split('/').pop()!)).toBe(true)
  const detail = (await (await get('/api/projects/filament')).json()) as any
  expect(detail.entryPoints.webhooks[0].tokenCreatedAt).toEqual(expect.any(String))
  expect(JSON.stringify(detail)).not.toContain(url.split('/').pop())
  expect((await rotate('nope')).status).toBe(404)
})
