import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createApp } from '../app.ts'
import { randomBytes } from 'node:crypto'
import { createProjectData, type ProjectData } from '../data/project-data.ts'
import { createDelivery } from '../delivery.ts'
import { createDevices } from '../devices/devices.ts'
import type { DeviceConnection } from '../devices/registry.ts'
import { createPairingCode, exchangePairingCode, recordHello } from '../devices/store.ts'
import { pkce } from '../devices/test-devices.ts'
import { createHomeAssistant } from '../homeassistant/client.ts'
import { startFakeHomeAssistant } from '../homeassistant/fake-ha.ts'
import { git } from '../git.ts'
import { repoPath } from '../host.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, DEFAULT_BRANCH } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain, type Files } from '../test-project.ts'
import { appSessionCookie, sendTo, signedIn, TEST_APPS_DOMAIN, TEST_PUBLIC_URL } from '../test-web.ts'
import { createSecretStore, type Actor } from '../secrets.ts'
import { recordVersion } from '../versions.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from '../workspaces.ts'
import { triggerRegistryLogger } from './homeassistant.ts'
import { getInvocation, listInvocations, queryLogs, startInvocation } from './logs.ts'
import { createRuntime, type Runtime, type RuntimeOptions } from './runtime.ts'
import { FAKE_PLACEHOLDER_PREFIX, fakeRuntimeSandboxes, type FakeRuntimeSandboxes } from './test-sandbox.ts'
import { rotateWebhookToken } from './webhooks.ts'

const HOST_ACTOR: Actor = { kind: 'host' }

// Every test builds and starts runners as host processes, which is slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>
let sandboxes: FakeRuntimeSandboxes
let runtime: Runtime
let server: Server | undefined
let data: ProjectData | undefined

const HOBWORK_JSON = {
  routes: {
    'GET /spools': { handler: 'src/spools.ts' },
    'GET /spools/:id': { handler: 'src/spool.ts' },
    'POST /fail': { handler: 'src/fail.ts' },
  },
  crons: { tick: { schedule: '0 8 * * *', handler: 'src/tick.ts' } },
  webhooks: { scanned: { handler: 'src/scanned.ts' } },
  idleTimeout: '1h',
}

const HANDLERS: Files = {
  'handlers/spools.js': `export default async () => [{ id: 1, color: 'red' }]`,
  'handlers/spool.js': `export default async (ctx) => ({ id: ctx.params.id, query: new URL(ctx.request.url).search })`,
  'handlers/fail.js': `export default async () => { console.error('failing now'); throw new Error('no spools today') }`,
  'handlers/tick.js': `export default async (ctx) => { console.log('tick', ctx.invocation.manual); ctx.log.info('done') }`,
  'handlers/scanned.js': `export default async (ctx) => new Response('scanned ' + (await ctx.request.text()), { status: 202 })`,
}

// Stands in for `vite build`: copies the plain JS handlers to where the runner loads them.
const BUILD = 'mkdir -p dist/handlers/src && cp handlers/*.js dist/handlers/src/'

function projectFiles(overrides: { hobwork?: object; handlers?: Files } = {}): Files {
  return {
    'package.json': fakePackageJson({ build: BUILD }),
    'hobwork.json': JSON.stringify(overrides.hobwork ?? HOBWORK_JSON),
    ...HANDLERS,
    ...overrides.handlers,
  }
}

function start(options: Partial<RuntimeOptions> = {}) {
  runtime = createRuntime(host, {
    createSandbox: sandboxes.factory,
    image: '/nonexistent-image',
    startBuildVm: startHostPipelineVm,
    ...options,
  })
  return runtime
}

// Commits the files to main as a new version, the way a merge would.
async function release(files: Files, summary = 'Release'): Promise<{ version: number; commit: string }> {
  const commit = await seedMain(host, 'filament', files)
  const { id } = host.db.prepare('SELECT id FROM projects WHERE name = ?').get('filament') as { id: number }
  const version = recordVersion(host, { projectId: id, commit, summary })
  return { version: version.number, commit }
}

async function deploy(files: Files = projectFiles()) {
  const { version, commit } = await release(files)
  await runtime.deploy({ project: 'filament', version, commit, reason: 'merge' })
  return version
}

async function listenApp(): Promise<string> {
  server = createApp(host, { runtime })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function until(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeEach(async () => {
  host = createTestHost()
  sandboxes = fakeRuntimeSandboxes()
  await createProject(host, 'filament')
})

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
    server = undefined
  }
  await runtime?.stop()
  await data?.stop()
  data = undefined
  host.dispose()
})

test('signed-in users call routes on the app origin, with the CSRF header for writes', async () => {
  start()
  await deploy()
  server = createApp(host, {
    runtime,
    web: { publicUrl: TEST_PUBLIC_URL, allowlist: { emails: ['kaan@example.com'], subjects: [] } },
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const { cookie } = signedIn(host)
  const appCookie = appSessionCookie(host, cookie, 'filament')
  const origin = `http://filament.${TEST_APPS_DOMAIN}`
  const send = (path: string, init: Parameters<typeof sendTo>[2] = {}) => sendTo(base, `${origin}${path}`, init)

  expect((await send('/api/spools', { headers: { cookie: 'hobwork_app=forged' } })).status).toBe(401)
  expect((await send('/api/spools', { headers: { cookie: appCookie } })).status).toBe(200)
  expect((await send('/api/fail', { method: 'POST', headers: { cookie: appCookie } })).status).toBe(403)
  const write = await send('/api/fail', { method: 'POST', headers: { cookie: appCookie, 'x-hobwork-csrf': '1', origin } })
  expect(write.status).toBe(500)

  const [project] = (await (await fetch(`${base}/api/projects`, { headers: { cookie } })).json()) as unknown[]
  expect(project).toMatchObject({ name: 'filament', status: 'running', currentVersion: { number: 2 } })
})

test('serves routes over HTTP for agents and records the invocation', async () => {
  start()
  const version = await deploy()
  const base = await listenApp()
  const { token } = createAgentToken(host.db, 'claude')
  const auth = { authorization: `Bearer ${token}` }

  expect((await fetch(`${base}/p/filament/api/spools`)).status).toBe(401)
  const res = await fetch(`${base}/p/filament/api/spools`, { headers: auth })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ id: 1, color: 'red' }])

  const one = await fetch(`${base}/p/filament/api/spools/7?full=1`, { headers: auth })
  expect(await one.json()).toEqual({ id: '7', query: '?full=1' })
  expect((await fetch(`${base}/p/filament/api/nope`, { headers: auth })).status).toBe(404)
  expect((await fetch(`${base}/p/filament/api/spools`, { method: 'DELETE', headers: auth })).status).toBe(405)

  const [latest] = listInvocations(host, { project: 'filament', limit: 1 })
  expect(latest).toMatchObject({ kind: 'route', name: 'GET /spools/:id', version, status: 'ok', httpStatus: 200 })
  expect(sandboxes.created).toHaveLength(1)
  expect(sandboxes.created[0]?.mounts?.['/app']?.readonly).toBe(true)
})

test('records a thrown error with its stack trace and console output', async () => {
  start()
  await deploy()
  const base = await listenApp()
  const { token } = createAgentToken(host.db, 'claude')
  const res = await fetch(`${base}/p/filament/api/fail`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  expect(res.status).toBe(500)
  const { invocation } = (await res.json()) as { invocation: number }
  const record = getInvocation(host, invocation)
  expect(record).toMatchObject({ status: 'error', error: 'Error: no spools today' })
  expect(record?.stack).toContain('fail.js')
  const lines = queryLogs(host, { project: 'filament', invocationId: invocation, limit: 10 })
  expect(lines.map((l) => [l.source, l.level, l.message.split('\n')[0]])).toEqual([
    ['handler', 'error', 'failing now'],
    ['runtime', 'error', 'route "POST /fail" failed: Error: no spools today'],
  ])
})

test('runs crons by hand with their log lines', async () => {
  start()
  await deploy()
  const outcome = await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true })
  expect(outcome.ok).toBe(true)
  const lines = queryLogs(host, { project: 'filament', invocationId: outcome.invocationId, limit: 10 })
  expect(lines.map((l) => l.message)).toEqual(['tick true', 'done'])
  expect(runtime.crons('filament')).toEqual([expect.objectContaining({ name: 'tick', schedule: '0 8 * * *' })])
  await expect(runtime.invoke('filament', { kind: 'cron', name: 'nope', manual: true })).rejects.toThrow('has no cron "nope"')
})

test('webhooks need their current token', async () => {
  start()
  await deploy()
  const base = await listenApp()
  expect((await fetch(`${base}/hooks/filament/scanned/wrong`, { method: 'POST' })).status).toBe(404)
  const token = rotateWebhookToken(host, 'filament', 'scanned')
  const res = await fetch(`${base}/hooks/filament/scanned/${token}`, { method: 'POST', body: 'spool 3' })
  expect(res.status).toBe(202)
  expect(await res.text()).toBe('scanned spool 3')
  rotateWebhookToken(host, 'filament', 'scanned')
  expect((await fetch(`${base}/hooks/filament/scanned/${token}`, { method: 'POST' })).status).toBe(404)
})

test('a deploy starts the new version, then stops the old one', async () => {
  start()
  await deploy()
  const first = [...sandboxes.running][0]
  const version = await deploy(projectFiles({ handlers: { 'handlers/spools.js': 'export default async () => "v2"' } }))
  expect(sandboxes.running.size).toBe(1)
  expect([...sandboxes.running][0]).not.toBe(first)
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  expect(outcome.ok && Buffer.from(outcome.response.body, 'base64').toString()).toBe('"v2"')
  expect(outcome.version).toBe(version)
  const events = queryLogs(host, { project: 'filament', source: 'runtime', limit: 50 }).map((l) => l.event)
  expect(events).toEqual(expect.arrayContaining(['deploy', 'start', 'stop']))
})

test('starts on demand after a host restart and stops when idle', async () => {
  await release(projectFiles({ hobwork: { ...HOBWORK_JSON, idleTimeout: '200ms' } }))
  start()
  await runtime.start()
  expect(sandboxes.running.size).toBe(0)
  const outcome = await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: false })
  expect(outcome.ok).toBe(true)
  expect(sandboxes.running.size).toBe(1)
  await until(() => sandboxes.running.size === 0)
  const stop = queryLogs(host, { project: 'filament', source: 'runtime', limit: 50 }).find((l) => l.event === 'stop')
  expect(stop?.message).toContain('idle')
})

test('the VM a deploy starts stops when nothing uses it', async () => {
  start()
  await deploy(projectFiles({ hobwork: { ...HOBWORK_JSON, idleTimeout: '200ms' } }))
  expect(sandboxes.running.size).toBe(1)
  await until(() => sandboxes.running.size === 0)
})

test('a crashed runtime is logged and replaced on the next invocation', async () => {
  start()
  await deploy()
  ;[...sandboxes.running][0]!.crash()
  await until(() => queryLogs(host, { project: 'filament', limit: 50 }).some((l) => l.event === 'crash'))
  const outcome = await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true })
  expect(outcome.ok).toBe(true)
  expect(sandboxes.created).toHaveLength(2)
})

test('invocations fail with an explanation when no runtime backend is configured', async () => {
  runtime = createRuntime(host, { startBuildVm: startHostPipelineVm })
  await deploy()
  const outcome = await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true })
  expect(outcome.ok).toBe(false)
  expect(!outcome.ok && outcome.error.message).toContain('no runtime VM backend')
})

async function withDelivery(options: Partial<RuntimeOptions> = {}) {
  const workspaces = createWorkspaceManager<ExecWorkspaceVm>(host)
  let delivery: ReturnType<typeof createDelivery> | undefined
  start({
    revert: (request) => delivery!.restore(request),
    autoRevert: { windowMs: 60_000, minFailures: 3, minFailingMs: 0 },
    ...options,
  })
  delivery = createDelivery(host, { workspaces, deploy: runtime.deploy })
  return delivery
}

async function mainSummary(): Promise<string> {
  return (await git(['--git-dir', repoPath(host, 'filament'), 'log', '-1', '--format=%s', DEFAULT_BRANCH])).trim()
}

test('reverts a merged version whose runtime does not start', async () => {
  await withDelivery()
  const good = await deploy()
  const broken = projectFiles({ handlers: { 'handlers/tick.js': 'export const oops = 1' } })
  await expect(deploy(broken)).rejects.toThrow(`Restoring version ${good} automatically`)
  await until(() => runtime.status('filament').version === good + 2)
  expect(await mainSummary()).toBe(`Auto-revert to version ${good}: version ${good + 1} did not start`)
  const revert = queryLogs(host, { project: 'filament', limit: 100 }).find((l) => l.event === 'auto-revert')
  expect(revert?.message).toContain(`Version ${good + 1} is broken`)
  expect((await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true })).ok).toBe(true)
})

test('reverts a merged version when every invocation fails', async () => {
  await withDelivery()
  const good = await deploy()
  await deploy(projectFiles({ handlers: { 'handlers/spools.js': 'export default async () => { throw new Error("x") }' } }))
  for (let i = 0; i < 3; i++) await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  await until(() => runtime.status('filament').version === good + 2)
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  expect(outcome.ok).toBe(true)
})

test('does not revert once a version had a successful invocation', async () => {
  await withDelivery()
  const good = await deploy()
  await deploy(projectFiles({ handlers: { 'handlers/spools.js': 'export default async () => { throw new Error("x") }' } }))
  expect((await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true })).ok).toBe(true)
  for (let i = 0; i < 4; i++) await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  await new Promise((r) => setTimeout(r, 100))
  expect(runtime.status('filament').version).toBe(good + 1)
})

test('a restore reuses the build of the restored tree', async () => {
  let builds = 0
  start({
    startBuildVm: async (options) => {
      builds++
      return startHostPipelineVm(options)
    },
  })
  const first = await deploy()
  await deploy(projectFiles({ handlers: { 'handlers/spools.js': 'export default async () => "v2"' } }))
  expect(builds).toBe(2)
  const delivery = createDelivery(host, { workspaces: createWorkspaceManager<ExecWorkspaceVm>(host), deploy: runtime.deploy })
  const restored = await delivery.restore({ project: 'filament', version: first })
  expect(restored.deployError).toBeUndefined()
  expect(builds).toBe(2)
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  expect(outcome.version).toBe(restored.version.number)
  expect(outcome.ok && JSON.parse(Buffer.from(outcome.response.body, 'base64').toString())).toEqual([{ id: 1, color: 'red' }])
})

test('deploy syncs Home Assistant triggers and logs the ones that fail', async () => {
  const synced: [string, unknown][] = []
  start({
    triggers: {
      async syncProjectTriggers(project, triggers) {
        synced.push([project, triggers])
        return [{ name: 'button', status: 'failed', error: 'Unknown device' }]
      },
      removeProject: async () => [],
      active: () => [],
    },
  })
  const button = { homeassistant: { trigger: 'state', entity_id: 'binary_sensor.button' }, handler: 'src/tick.ts' }
  await deploy(projectFiles({ hobwork: { ...HOBWORK_JSON, triggers: { button } } }))
  expect(synced).toEqual([['filament', { button }]])
  const event = queryLogs(host, { project: 'filament', limit: 50 }).find((l) => l.event === 'trigger')
  expect(event).toMatchObject({ level: 'error', message: 'Trigger "button" could not be subscribed: Unknown device' })
  const outcome = await runtime.invoke('filament', { kind: 'trigger', name: 'button', manual: false, payload: { trigger: {} } })
  expect(outcome.ok).toBe(true)
})

test('trigger registry messages go to the project log', () => {
  triggerRegistryLogger(host).error('Home Assistant refused trigger "button" of project "filament": invalid')
  triggerRegistryLogger(host).error('Invoking trigger "a" of project "missing" failed')
  const lines = queryLogs(host, { project: 'filament', limit: 10 })
  expect(lines).toEqual([expect.objectContaining({ event: 'trigger', level: 'error' })])
  expect(lines[0]?.message).toContain('refused trigger "button"')
})

function bodyOf(outcome: Awaited<ReturnType<Runtime['invoke']>>): unknown {
  if (!outcome.ok) throw new Error(`${outcome.error.name}: ${outcome.error.message}`)
  return JSON.parse(Buffer.from(outcome.response.body, 'base64').toString())
}

const COUNTER_JSON = { ...HOBWORK_JSON, routes: { ...HOBWORK_JSON.routes, 'POST /hits': { handler: 'src/hits.ts' } } }
const COUNTER = {
  'migrations/0001_hits.sql': 'CREATE TABLE hits (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT;',
  'handlers/hits.js': `export default async (ctx) => {
    await ctx.db.run('INSERT INTO hits (label) VALUES (?)', ['visit'])
    return ctx.db.get('SELECT count(*) AS n FROM hits')
  }`,
}

test('deploy applies migrations and handlers keep data in the project DB across invocations', async () => {
  data = createProjectData(host)
  start({ data })
  await deploy(projectFiles({ hobwork: COUNTER_JSON, handlers: COUNTER }))
  const hit = () => runtime.invoke('filament', { kind: 'route', name: 'POST /hits', manual: true })
  expect(bodyOf(await hit())).toEqual({ n: 1 })
  ;[...sandboxes.running][0]!.crash()
  await until(() => sandboxes.running.size === 0 || queryLogs(host, { project: 'filament', limit: 50 }).some((l) => l.event === 'crash'))
  expect(bodyOf(await hit())).toEqual({ n: 2 })
  const applied = queryLogs(host, { project: 'filament', limit: 50 }).find((l) => l.event === 'db')
  expect(applied?.message).toBe('Applied migrations: 0001_hits.sql')
})

test('a version whose migration fails on deploy is reverted', async () => {
  data = createProjectData(host)
  await withDelivery({ data })
  const good = await deploy(projectFiles({ hobwork: COUNTER_JSON, handlers: COUNTER }))
  const broken = projectFiles({
    hobwork: COUNTER_JSON,
    handlers: { ...COUNTER, 'migrations/0002_bad.sql': 'CREATE TABLE hits (id INTEGER PRIMARY KEY) STRICT;' },
  })
  await expect(deploy(broken)).rejects.toThrow(`Restoring version ${good} automatically`)
  await until(() => runtime.status('filament').version === good + 2)
  const failed = queryLogs(host, { project: 'filament', limit: 100 }).find((l) => l.event === 'migration')
  expect(failed?.message).toContain('0002_bad.sql failed: table hits already exists')
})

test('slow queries are logged with their invocation', async () => {
  data = createProjectData(host, { slowQueryMs: 0 })
  start({ data })
  await deploy(projectFiles({ hobwork: COUNTER_JSON, handlers: COUNTER }))
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'POST /hits', manual: true })
  const slow = queryLogs(host, { project: 'filament', invocationId: outcome.invocationId, limit: 10 }).filter((l) => l.event === 'db')
  expect(slow.map((l) => l.message.split(':')[1]?.trim())).toEqual([
    "INSERT INTO hits (label) VALUES (?). Add an index in a migration or narrow the query",
    'SELECT count(*) AS n FROM hits. Add an index in a migration or narrow the query',
  ])
  expect(data.status('filament').slowQueries.count).toBe(2)
})

test('secrets reach runtime VMs as placeholders, their hosts join egress, and a change starts a new VM', async () => {
  const secrets = createSecretStore(host, randomBytes(32))
  const spools = secrets.create({ name: 'Spools', value: 'real-value', hosts: ['api.spools.example'] }, HOST_ACTOR)
  secrets.assign('filament', spools.id, 'SPOOL_API_KEY', HOST_ACTOR)
  secrets.create(
    { name: 'Shared', value: 'shared', hosts: ['shared.example'], assign: { project: 'filament', envName: 'SHARED_TOKEN' } },
    HOST_ACTOR,
  )
  start({ secrets })
  await deploy(
    projectFiles({
      hobwork: { ...HOBWORK_JSON, egress: ['weather.example'] },
      handlers: { 'handlers/spools.js': 'export default async (ctx) => ctx.secrets' },
    }),
  )
  const [options] = sandboxes.created
  expect(options?.egress?.sort()).toEqual(['api.spools.example', 'shared.example', 'weather.example'])
  expect(options?.secrets).toEqual({
    SHARED_TOKEN: { value: 'shared', hosts: ['shared.example'] },
    SPOOL_API_KEY: { value: 'real-value', hosts: ['api.spools.example'] },
  })
  const route = () => runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  expect(bodyOf(await route())).toEqual({
    SHARED_TOKEN: `${FAKE_PLACEHOLDER_PREFIX}SHARED_TOKEN`,
    SPOOL_API_KEY: `${FAKE_PLACEHOLDER_PREFIX}SPOOL_API_KEY`,
  })

  secrets.update(spools.id, { value: 'rotated' }, HOST_ACTOR)
  await route()
  expect(sandboxes.created).toHaveLength(2)
  expect(sandboxes.created[1]?.secrets?.SPOOL_API_KEY?.value).toBe('rotated')
  await until(() => sandboxes.running.size === 1)
  const stop = queryLogs(host, { project: 'filament', source: 'runtime', limit: 50 }).find((l) => l.event === 'stop')
  expect(stop?.message).toContain('secrets changed')

  secrets.unassign('filament', 'SPOOL_API_KEY', HOST_ACTOR)
  expect(bodyOf(await route())).toEqual({ SHARED_TOKEN: `${FAKE_PLACEHOLDER_PREFIX}SHARED_TOKEN` })
  expect(sandboxes.created).toHaveLength(3)
  expect(sandboxes.created[2]?.egress?.sort()).toEqual(['shared.example', 'weather.example'])

  secrets.assign('filament', spools.id, 'SPOOLS', HOST_ACTOR)
  expect(bodyOf(await route())).toEqual({
    SHARED_TOKEN: `${FAKE_PLACEHOLDER_PREFIX}SHARED_TOKEN`,
    SPOOLS: `${FAKE_PLACEHOLDER_PREFIX}SPOOLS`,
  })
  expect(sandboxes.created).toHaveLength(4)
  expect(sandboxes.created[3]?.egress?.sort()).toEqual(['api.spools.example', 'shared.example', 'weather.example'])
})

test('blocked egress is logged to the project log', async () => {
  start()
  await deploy()
  sandboxes.created[0]?.onEgressBlocked?.({ hostname: 'tracker.example', ip: '', port: 443 })
  const blocked = queryLogs(host, { project: 'filament', limit: 50 }).find((l) => l.event === 'egress-blocked')
  expect(blocked).toMatchObject({ level: 'warn', message: expect.stringContaining('tracker.example:443') })
})

test('handlers call Home Assistant through the host, logged with their invocation', async () => {
  const fake = await startFakeHomeAssistant()
  const ha = createHomeAssistant({ connection: () => ({ url: fake.url, token: fake.token }), logger: { info() {}, warn() {}, error() {} } })
  try {
    fake.responses.set('call_service', () => ({ context: { id: 'c1', parent_id: null, user_id: null } }))
    fake.responses.set('get_states', () => [{ entity_id: 'light.kitchen', state: 'on', attributes: {} }])
    ha.start()
    await ha.waitUntilConnected()
    start({ homeAssistant: ha })
    await deploy(
      projectFiles({
        handlers: {
          'handlers/spools.js': `export default async (ctx) => {
            try {
              await ctx.ha.callService('light', 'turn_on', { brightness: 50 }, { entity_id: 'light.kitchen' })
              return { state: (await ctx.ha.getState('light.kitchen')).state }
            } catch (err) {
              return { error: [err.name, err.code, err.message] }
            }
          }`,
        },
      }),
    )
    const route = () => runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
    const ok = await route()
    expect(bodyOf(ok)).toEqual({ state: 'on' })
    expect(fake.received.find((m) => m.type === 'call_service')).toMatchObject({
      domain: 'light',
      service: 'turn_on',
      service_data: { brightness: 50 },
      target: { entity_id: 'light.kitchen' },
    })
    const lines = queryLogs(host, { project: 'filament', invocationId: ok.invocationId, limit: 10 })
    expect(lines.map((l) => `${l.level} ${l.message}`)).toEqual([
      'info Home Assistant: light.turn_on {"brightness":50} target {"entity_id":"light.kitchen"}',
      'debug Home Assistant: get state of light.kitchen',
    ])

    fake.failures.set('call_service', { code: 'service_not_found', message: 'Action light.turn_on not found' })
    expect(bodyOf(await route())).toEqual({ error: ['HomeAssistantError', 'service_not_found', 'Action light.turn_on not found'] })

    // The endpoint is bound to the VM's project, so an invocation of another
    // project is not attributed.
    await createProject(host, 'other')
    const foreign = startInvocation(host, { project: 'other', version: null, kind: 'cron', name: 'x', manual: false })
    fake.failures.clear()
    await sandboxes.created[0]!.internal!(
      new Request('http://hobwork.internal/v1/ha', {
        method: 'POST',
        body: JSON.stringify({ action: 'callService', domain: 'light', service: 'turn_off', invocation: foreign }),
      }),
    )
    expect(queryLogs(host, { project: 'other', limit: 10 })).toEqual([])
    const unattributed = queryLogs(host, { project: 'filament', limit: 50 }).find((l) => l.message.includes('light.turn_off'))
    expect(unattributed?.invocationId).toBeNull()
  } finally {
    ha.stop()
    await fake.close()
  }
})

test('handlers notify devices, and a tapped notification action runs the device trigger', async () => {
  const devices = createDevices({
    host,
    triggers: async (project) => (await runtime.config(project)).config.triggers,
    invokeTrigger: (project, name, payload) => runtime.invoke(project, { kind: 'trigger', name, manual: false, payload }),
  })
  start({ devices })
  const { user } = signedIn(host)
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId: user.id, name: 'kaan-iphone', platform: 'ios', codeChallenge: challenge })
  const { device } = exchangePairingCode(host.db, code, verifier)
  recordHello(host.db, device.id, { appVersion: '1.0', capabilities: ['notifications'] })
  // Stands in for the app's socket and shows every notification.
  const shown: unknown[] = []
  const app: DeviceConnection = {
    deviceId: device.id,
    send(message) {
      if (message.type !== 'call') return
      shown.push(message.args)
      queueMicrotask(() => devices.registry.result(app, { id: message.id, ok: true, value: null }))
    },
    close() {},
  }
  devices.registry.attach(app)

  await deploy(
    projectFiles({
      hobwork: { ...HOBWORK_JSON, triggers: { tapped: { device: { capability: 'notifications', event: 'action' }, handler: 'src/tapped.ts' } } },
      handlers: {
        'handlers/spools.js': `export default async (ctx) => {
          const sent = await ctx.device('kaan-iphone').notifications.send({ title: 'Spool low', actions: [{ id: 'order', title: 'Order' }], data: { spool: 4 } })
          return { sent, devices: (await ctx.devices()).map((d) => [d.name, d.connected]) }
        }`,
        'handlers/tapped.js': `export default async (ctx) => { console.log(JSON.stringify(ctx.payload)) }`,
      },
    }),
  )
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  const body = bodyOf(outcome) as { sent: { id: string; delivery: string }; devices: unknown[] }
  expect(body).toEqual({ sent: { id: expect.any(String), delivery: 'app' }, devices: [['kaan-iphone', true]] })
  expect(shown).toEqual([{ id: body.sent.id, project: 'filament', title: 'Spool low', actions: [{ id: 'order', title: 'Order' }] }])
  expect(queryLogs(host, { project: 'filament', invocationId: outcome.invocationId, limit: 10 }).map((l) => l.message)).toContain(
    'Device kaan-iphone: sent notification "Spool low" (to the app)',
  )

  await devices.handleEvent(device.id, { capability: 'notifications', name: 'action', data: { id: body.sent.id, action: 'order' } })
  const runs = () => listInvocations(host, { project: 'filament', kind: 'trigger', limit: 5 })
  await until(() => runs()[0]?.status === 'ok')
  const [run] = runs()
  expect(run).toMatchObject({ name: 'tapped', status: 'ok', manual: false })
  const logged = queryLogs(host, { project: 'filament', invocationId: run!.id, limit: 5 }).map((l) => JSON.parse(l.message) as unknown)
  expect(logged).toEqual([
    { device: 'kaan-iphone', capability: 'notifications', event: 'action', notificationId: body.sent.id, action: 'order', data: { spool: 4 } },
  ])
})
