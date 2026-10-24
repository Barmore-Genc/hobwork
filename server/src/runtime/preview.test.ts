import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createProjectData, type ProjectData } from '../data/project-data.ts'
import { setHaServices } from '../homeassistant/services.ts'
import { createHomeAssistant, type HomeAssistant } from '../homeassistant/client.ts'
import { startFakeHomeAssistant, type FakeHomeAssistant } from '../homeassistant/fake-ha.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, requireProject } from '../projects.ts'
import { createSecretStore } from '../secrets.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedBranch, seedMain, type Files } from '../test-project.ts'
import {
  appSessionCookie,
  sendTo,
  signedIn,
  startTestApp,
  TEST_APPS_DOMAIN,
  writeHeaders,
} from '../test-web.ts'
import { recordVersion } from '../versions.ts'
import { existsSync, readdirSync } from 'node:fs'
import { deleteProject } from '../project-deletion.ts'
import { defaultResources } from '../sandbox/budget.ts'
import { createWorkspaceManager } from '../workspaces.ts'
import { projectBuildsDir, treeOf } from './builds.ts'
import { repoPath } from '../host.ts'
import { listInvocations, queryLogs } from './logs.ts'
import { createRuntime, type Runtime, type RuntimeOptions } from './runtime.ts'
import { fakeRuntimeSandboxes, type FakeRuntimeSandboxes } from './test-sandbox.ts'
import { rotateBranchWebhookToken, rotateWebhookToken } from './webhooks.ts'

vi.setConfig({ testTimeout: 30_000 })

const MAIN = `http://filament.${TEST_APPS_DOMAIN}`
const PREVIEW = `http://add-spools--filament.${TEST_APPS_DOMAIN}`

const HOBWORK_JSON = {
  routes: { 'GET /spools': { handler: 'src/spools.ts' }, 'POST /lights': { handler: 'src/lights.ts' } },
  crons: { tick: { schedule: '0 8 * * *', handler: 'src/tick.ts' } },
  webhooks: { scanned: { handler: 'src/scanned.ts' }, page: { handler: 'src/page.ts' } },
  triggers: { button: { homeassistant: { trigger: 'state', entity_id: 'input_button.desk' }, handler: 'src/tick.ts' } },
}

function files(where: string, extra: Files = {}, idleTimeout?: string): Files {
  const build = [
    'mkdir -p dist/handlers/src',
    `printf '<!doctype html><html><head><title>${where}</title></head><body></body></html>' > dist/index.html`,
    'cp handlers/*.js dist/handlers/src/',
  ].join(' && ')
  return {
    'package.json': fakePackageJson({ build }),
    'hobwork.json': JSON.stringify({ ...HOBWORK_JSON, ...(idleTimeout ? { idleTimeout } : {}) }),
    'handlers/spools.js': `export default async () => ({ where: '${where}' })`,
    'handlers/tick.js': `export default async (ctx) => ({ where: '${where}', manual: ctx.invocation.manual })`,
    'handlers/scanned.js': `export default async (ctx) => ({ where: '${where}', body: await ctx.request.text() })`,
    'handlers/page.js': `export default async () => new Response('<script>fetch("/api/session")</script>', {
      headers: [['Content-Type', 'text/html'], ['Content-Security-Policy', 'default-src *'], ['Set-Cookie', 'a=1'], ['set-cookie', 'b=2']],
    })`,
    'handlers/lights.js': `export default async (ctx) => {
      const state = (await ctx.ha.getState('light.kitchen'))?.state
      try {
        await ctx.ha.callService('light', 'turn_on', {}, { entity_id: 'light.kitchen' })
        return { state, called: true }
      } catch (err) {
        return { state, called: false, code: err.code }
      }
    }`,
    ...extra,
  }
}

let host: ReturnType<typeof createTestHost>
let sandboxes: FakeRuntimeSandboxes
let runtime: Runtime
let data: ProjectData
let app: Awaited<ReturnType<typeof startTestApp>>
let fakeHa: FakeHomeAssistant | undefined
let ha: HomeAssistant | undefined

async function start(options: Partial<RuntimeOptions> = {}) {
  sandboxes = fakeRuntimeSandboxes()
  data = createProjectData(host)
  runtime = createRuntime(host, {
    createSandbox: sandboxes.factory,
    image: '/nonexistent-image',
    startBuildVm: startHostPipelineVm,
    data,
    secrets: createSecretStore(host, randomBytes(32)),
    ...options,
  })
  app = await startTestApp(host, { runtime, data })
  await createProject(host, 'filament')
  const commit = await seedMain(host, 'filament', files('main'))
  const version = recordVersion(host, { projectId: requireProject(host, 'filament').id, commit, summary: 'Spools' })
  await runtime.deploy({ project: 'filament', version: version.number, commit, reason: 'merge' })
}

beforeEach(() => {
  host = createTestHost()
})

afterEach(async () => {
  await app?.close()
  await runtime?.stop()
  await data?.stop()
  ha?.stop()
  await fakeHa?.close()
  fakeHa = undefined
  ha = undefined
  host.dispose()
})

const send = (url: string, init?: Parameters<typeof sendTo>[2]) => sendTo(app.base, url, init)

test('a branch preview has its own origin, build, routes and session', async () => {
  await start()
  await seedBranch(host, 'filament', 'add-spools', files('branch'))
  const { cookie } = signedIn(host)
  const previewCookie = appSessionCookie(host, cookie, 'filament', 'add-spools')
  const mainCookie = appSessionCookie(host, cookie, 'filament')

  const page = await send(`${PREVIEW}/spools/1`, { headers: { accept: 'text/html', cookie: previewCookie } })
  expect(page.status).toBe(200)
  expect(page.body).toContain('<title>branch</title>')
  const route = await send(`${PREVIEW}/api/spools`, { headers: { cookie: previewCookie } })
  expect(JSON.parse(route.body)).toEqual({ where: 'branch' })
  expect(JSON.parse((await send(`${MAIN}/api/spools`, { headers: { cookie: mainCookie } })).body)).toEqual({ where: 'main' })

  // Each origin takes only its own session.
  expect((await send(`${PREVIEW}/api/spools`, { headers: { cookie: mainCookie } })).status).toBe(401)
  expect((await send(`${MAIN}/api/spools`, { headers: { cookie: previewCookie } })).status).toBe(401)
  const signIn = await send(`${PREVIEW}/`, { headers: { accept: 'text/html' } })
  const handoff = new URL(signIn.headers.location!)
  expect(handoff.searchParams.get('branch')).toBe('add-spools')
  expect(handoff.searchParams.get('returnTo')).toBe(`${PREVIEW}/`)
  const toApp = await send(handoff.href, { headers: { cookie } })
  expect(toApp.headers.location).toMatch(new RegExp(`^${PREVIEW}/_hobwork/callback\\?`))
  // A code for the preview does not work on main's origin.
  expect((await send(toApp.headers.location!.replace(PREVIEW, MAIN))).status).toBe(400)

  const [latest] = listInvocations(host, { project: 'filament', branch: 'add-spools', limit: 1 })
  expect(latest).toMatchObject({ kind: 'route', branch: 'add-spools', version: null, status: 'ok' })
  expect(listInvocations(host, { project: 'filament', branch: null, limit: 5 })).toHaveLength(1)
  expect(runtime.previewStatus('filament', 'add-spools').running).toBe(true)
  const started = queryLogs(host, { project: 'filament', limit: 50 }).find((l) => l.branch === 'add-spools' && l.event === 'start')
  expect(started?.message).toMatch(/^Runtime of preview of add-spools at [0-9a-f]{7} started/)

  expect((await send(`http://nope--filament.${TEST_APPS_DOMAIN}/`, { headers: { accept: 'text/html' } })).status).toBe(404)
})

test('a new commit on the branch replaces the preview on the next request', async () => {
  await start()
  await seedBranch(host, 'filament', 'add-spools', files('first'))
  expect((await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true, branch: 'add-spools' })).ok).toBe(true)
  await seedBranch(host, 'filament', 'add-spools', files('second'))
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true, branch: 'add-spools' })
  expect(outcome.ok && JSON.parse(Buffer.from(outcome.response.body, 'base64').toString())).toEqual({ where: 'second' })
  await vi.waitFor(() => expect(sandboxes.running.size).toBe(2))
})

test('crons and triggers of a branch run only by hand', async () => {
  await start()
  await seedBranch(host, 'filament', 'add-spools', files('branch'))
  expect(runtime.crons('filament').map((c) => c.name)).toEqual(['tick'])
  const cron = await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true, branch: 'add-spools' })
  expect(cron.ok).toBe(true)
  const trigger = await runtime.invoke('filament', { kind: 'trigger', name: 'button', manual: true, branch: 'add-spools', payload: {} })
  expect(trigger.ok).toBe(true)
  expect(listInvocations(host, { project: 'filament', branch: 'add-spools', limit: 5 }).map((i) => [i.kind, i.manual])).toEqual([
    ['trigger', true],
    ['cron', true],
  ])
})

test('branch webhooks have their own URL and token', async () => {
  await start()
  await seedBranch(host, 'filament', 'add-spools', files('branch'))
  const mainToken = rotateWebhookToken(host, 'filament', 'scanned')
  const branchToken = rotateBranchWebhookToken(host, 'filament', 'add-spools', 'scanned')
  const hook = (target: string, token: string) =>
    sendTo(app.base, `http://${target}.${TEST_APPS_DOMAIN}/_hobwork/hooks/scanned/${token}`, { method: 'POST', body: 'spool 3' })

  const branch = await hook('add-spools--filament', branchToken)
  expect(branch.status).toBe(200)
  expect(JSON.parse(branch.body)).toEqual({ where: 'branch', body: 'spool 3' })
  expect(JSON.parse((await hook('filament', mainToken)).body)).toEqual({ where: 'main', body: 'spool 3' })
  expect((await hook('add-spools--filament', mainToken)).status).toBe(404)
  expect((await hook('filament', branchToken)).status).toBe(404)
  expect((await hook('nope--filament', branchToken)).status).toBe(404)
  const [latest] = listInvocations(host, { project: 'filament', branch: 'add-spools', limit: 1 })
  expect(latest).toMatchObject({ kind: 'webhook', branch: 'add-spools', manual: false })
})

test('branch webhook pages are sandboxed and cannot set cookies', async () => {
  await start()
  await seedBranch(host, 'filament', 'add-spools', files('branch'))
  const token = rotateBranchWebhookToken(host, 'filament', 'add-spools', 'page')
  const res = await sendTo(app.base, `${PREVIEW}/_hobwork/hooks/page/${token}`)
  expect(res.body).toContain('<script>')
  expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  expect(res.headers['set-cookie']).toBeUndefined()
})

test('previews use the branch DB, never production', async () => {
  await start()
  const migration = 'CREATE TABLE spools (color TEXT) STRICT;\n'
  await seedBranch(
    host,
    'filament',
    'add-spools',
    files('branch', {
      'migrations/0001_spools.sql': migration,
      'handlers/spools.js': `export default async (ctx) => {
        await ctx.db.run('INSERT INTO spools (color) VALUES (?)', ['red'])
        return ctx.db.query('SELECT color FROM spools')
      }`,
    }),
  )
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true, branch: 'add-spools' })
  expect(outcome.ok && JSON.parse(Buffer.from(outcome.response.body, 'base64').toString())).toEqual([{ color: 'red' }])
  const production = await data.execute({ project: 'filament' }, {
    statements: [{ sql: "SELECT name FROM sqlite_schema WHERE name = 'spools'" }],
    transaction: false,
  })
  expect(production).toMatchObject({ ok: true, results: [{ rows: [] }] })
})

test('previews stop when idle', async () => {
  await start()
  await seedBranch(host, 'filament', 'add-spools', files('branch', {}, '1s'))
  await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true, branch: 'add-spools' })
  expect(runtime.previewStatus('filament', 'add-spools').running).toBe(true)
  await vi.waitFor(() => expect(runtime.previewStatus('filament', 'add-spools').running).toBe(false), { timeout: 5000 })
  expect(sandboxes.created.at(-1)).toMatchObject({ memory: '384M', cpus: defaultResources().runtime.cpus })
})

test('branch handlers call Home Assistant services only while a person allows it', async () => {
  fakeHa = await startFakeHomeAssistant()
  fakeHa.responses.set('call_service', () => ({ context: { id: 'c1', parent_id: null, user_id: null } }))
  fakeHa.responses.set('get_states', () => [{ entity_id: 'light.kitchen', state: 'off', attributes: {} }])
  const fake = fakeHa
  ha = createHomeAssistant({ connection: () => ({ url: fake.url, token: fake.token }), logger: { info() {}, warn() {}, error() {} } })
  ha.start()
  await ha.waitUntilConnected()
  await start({ homeAssistant: ha })
  setHaServices(host, 'filament', ['light'], { kind: 'user', name: 'Kaan' })
  await seedBranch(host, 'filament', 'add-spools', files('branch'))
  const lights = async () => {
    const outcome = await runtime.invoke('filament', { kind: 'route', name: 'POST /lights', manual: true, branch: 'add-spools' })
    if (!outcome.ok) throw new Error(outcome.error.message)
    return { id: outcome.invocationId, body: JSON.parse(Buffer.from(outcome.response.body, 'base64').toString()) }
  }

  // Reads work; service calls are denied and logged so the agent can ask.
  const denied = await lights()
  expect(denied.body).toEqual({ state: 'off', called: false, code: 'not_approved' })
  expect(fake.received.some((m) => m.type === 'call_service')).toBe(false)
  const line = queryLogs(host, { project: 'filament', invocationId: denied.id, limit: 10 }).find((l) => l.level === 'warn')
  expect(line).toMatchObject({ branch: 'add-spools', source: 'runtime' })
  expect(line?.message).toContain('Home Assistant: denied light.turn_on')
  expect(line?.message).toContain('Let this branch control Home Assistant')

  // Agents cannot allow it; a signed-in person can, and can take it back.
  const path = `/api/projects/filament/branches/add-spools/home-assistant`
  const { token } = createAgentToken(host.db, 'claude')
  expect((await fetch(`${app.base}${path}`, { method: 'PUT', headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
  const { cookie } = signedIn(host)
  expect((await fetch(`${app.base}${path}`, { method: 'PUT', headers: { cookie } })).status).toBe(403)
  const granted = await fetch(`${app.base}${path}`, { method: 'PUT', headers: writeHeaders(cookie) })
  expect(granted.status).toBe(200)
  expect(await granted.json()).toEqual({ by: 'Kaan', byAgent: false, grantedAt: expect.any(String) })
  expect((await lights()).body).toEqual({ state: 'off', called: true })
  expect(fake.received.filter((m) => m.type === 'call_service')).toHaveLength(1)

  const branches = (await (await fetch(`${app.base}/api/projects/filament/branches`, { headers: { cookie } })).json()) as any[]
  expect(branches).toEqual([
    expect.objectContaining({
      name: 'add-spools',
      previewUrl: PREVIEW,
      running: true,
      homeAssistant: { by: 'Kaan', byAgent: false, grantedAt: expect.any(String) },
      recentRuns: [expect.objectContaining({ name: 'POST /lights', branch: 'add-spools' }), expect.anything()],
    }),
  ])

  expect((await fetch(`${app.base}${path}`, { method: 'DELETE', headers: writeHeaders(cookie) })).status).toBe(204)
  expect((await lights()).body).toMatchObject({ called: false, code: 'not_approved' })
  expect((await fetch(`${app.base}/api/projects/filament/branches/nope/home-assistant`, { method: 'PUT', headers: writeHeaders(cookie) })).status).toBe(404)
  expect((await fetch(`${app.base}/api/projects/filament/branches/main/home-assistant`, { method: 'PUT', headers: writeHeaders(cookie) })).status).toBe(404)
})

test('activity can be filtered by branch', async () => {
  await start()
  await seedBranch(host, 'filament', 'add-spools', files('branch'))
  await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true, branch: 'add-spools' })
  await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  const { cookie } = signedIn(host)
  const list = async (query: string) =>
    ((await (await fetch(`${app.base}/api/projects/filament/invocations${query}`, { headers: { cookie } })).json()) as any).invocations.map(
      (i: { branch: string | null }) => i.branch,
    )
  expect(await list('')).toEqual([null])
  expect(await list('?branch=*')).toEqual([null, 'add-spools'])
  expect(await list('?branch=add-spools')).toEqual(['add-spools'])
  expect(await list('?branch=main')).toEqual([null])
})

test('deleting a project stops its previews', async () => {
  await start()
  await seedBranch(host, 'filament', 'add-spools', files('branch'))
  await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true, branch: 'add-spools' })
  expect(sandboxes.running.size).toBe(2)
  await deleteProject({ host, workspaces: createWorkspaceManager(host), runtime, data }, 'filament')
  expect(sandboxes.running.size).toBe(0)
  expect(runtime.previewStatus('filament', 'add-spools').running).toBe(false)
})

test('build cleanup keeps the builds previews run and removes them afterwards', async () => {
  await start({ buildRetention: { keepVersions: 1, minAgeMs: 0 } })
  const commit = await seedBranch(host, 'filament', 'add-spools', files('branch', {}, '1s'))
  const tree = await treeOf(repoPath(host, 'filament'), commit)
  await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true, branch: 'add-spools' })
  await runtime.removeOldBuilds('filament')
  expect(readdirSync(projectBuildsDir(host, 'filament'))).toContain(tree)
  // Once the preview stops for being idle, its build goes.
  await vi.waitFor(() => expect(existsSync(`${projectBuildsDir(host, 'filament')}/${tree}`)).toBe(false), { timeout: 5000 })
})

test('log lines from a preview never attach to an invocation of main', async () => {
  await start()
  const mainRun = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  await seedBranch(
    host,
    'filament',
    'add-spools',
    files('branch', {
      'handlers/spools.js': `export default async (ctx) => {
        await fetch(process.env.HOBWORK_INTERNAL_URL + '/v1/logs', {
          method: 'POST',
          body: JSON.stringify({ lines: [{ invocation: ${mainRun.invocationId}, level: 'info', message: 'forged' }] }),
        })
        return 'ok'
      }`,
    }),
  )
  const preview = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true, branch: 'add-spools' })
  const lines = queryLogs(host, { project: 'filament', limit: 100 }).filter((l) => l.message === 'forged')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ branch: 'add-spools', invocationId: null })
  expect(preview.invocationId).not.toBe(mainRun.invocationId)
})
