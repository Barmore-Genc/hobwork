import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken, verifyAgentToken } from './agents.ts'
import { createProjectData, type ProjectData } from './data/project-data.ts'
import { createDelivery, type Delivery } from './delivery.ts'
import type { TriggerRegistry } from './homeassistant/triggers.ts'
import { repoPath } from './host.ts'
import { startTestMcp } from './mcp/test-mcp.ts'
import { projectPaths, renameProject } from './project-rename.ts'
import { createProject, getProject, requireProject } from './projects.ts'
import { branchHead, createBranch } from './repo.ts'
import { startHostPipelineVm } from './pipeline/host-backend.ts'
import { queryLogs } from './runtime/logs.ts'
import { createRuntime, type Runtime } from './runtime/runtime.ts'
import { fakeRuntimeSandboxes, type FakeRuntimeSandboxes } from './runtime/test-sandbox.ts'
import { rotateWebhookToken } from './runtime/webhooks.ts'
import { createSecretStore, type SecretStore } from './secrets.ts'
import { createStorageUsage } from './storage.ts'
import { createTestHost } from './test-host.ts'
import { fakePackageJson, seedMain } from './test-project.ts'
import { sendTo, signedIn, startTestApp, TEST_APPS_DOMAIN, writeHeaders } from './test-web.ts'
import { recordVersion } from './versions.ts'
import { createWorkspaceManager, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

vi.setConfig({ testTimeout: 30_000 })

const FILES = {
  'package.json': fakePackageJson({ build: 'mkdir -p dist/handlers/src && cp handlers/*.js dist/handlers/src/' }),
  'hobwork.json': JSON.stringify({
    routes: { 'GET /spools': { handler: 'src/spools.ts' } },
    crons: { tick: { schedule: '0 8 * * *', handler: 'src/tick.ts' } },
    webhooks: { scanned: { handler: 'src/scanned.ts' } },
    triggers: { desk: { homeassistant: { trigger: 'state', entity_id: 'input_button.desk' }, handler: 'src/desk.ts' } },
  }),
  'migrations/0001_spools.sql': 'CREATE TABLE spools (id INTEGER PRIMARY KEY, color TEXT) STRICT;',
  'handlers/spools.js': `export default async (ctx) => ctx.db.query('SELECT color FROM spools')`,
  'handlers/tick.js': `export default async (ctx) => { await ctx.db.run("INSERT INTO spools (color) VALUES ('red')") }`,
  'handlers/scanned.js': 'export default async () => ({ scanned: true })',
  'handlers/desk.js': 'export default async () => undefined',
}

let host: ReturnType<typeof createTestHost>
let sandboxes: FakeRuntimeSandboxes
let runtime: Runtime
let data: ProjectData
let secrets: SecretStore
let delivery: Delivery
let workspaces: WorkspaceManager<ExecWorkspaceVm>
let app: Awaited<ReturnType<typeof startTestApp>>
let triggerCalls: string[]
let stoppedWorkspaces: string[]
let cookie: string
let webhookToken: string

beforeEach(async () => {
  host = createTestHost()
  sandboxes = fakeRuntimeSandboxes()
  triggerCalls = []
  stoppedWorkspaces = []
  const triggers: TriggerRegistry = {
    syncProjectTriggers: async (project) => {
      triggerCalls.push(`sync ${project}`)
      return []
    },
    removeProject: async (project) => {
      triggerCalls.push(`remove ${project}`)
      return []
    },
    active: () => [],
  }
  secrets = createSecretStore(host, randomBytes(32))
  data = createProjectData(host)
  runtime = createRuntime(host, {
    createSandbox: sandboxes.factory,
    image: '/nonexistent-image',
    startBuildVm: startHostPipelineVm,
    triggers,
    data,
    secrets,
  })
  workspaces = createWorkspaceManager(host, {
    startVm: async (workspace) => ({
      stop: async () => void stoppedWorkspaces.push(`${workspace.project}/${workspace.branch}`),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }),
  })
  delivery = createDelivery(host, { workspaces, deploy: runtime.deploy })
  app = await startTestApp(host, { runtime, data, secrets, delivery, workspaces })
  cookie = signedIn(host).cookie

  await createProject(host, 'filament')
  const commit = await seedMain(host, 'filament', FILES)
  const version = recordVersion(host, { projectId: requireProject(host, 'filament').id, commit, summary: 'Track spools' })
  await runtime.deploy({ project: 'filament', version: version.number, commit, reason: 'merge' })
  secrets.create(
    { name: 'Spool API', value: 'x', hosts: ['api.spools.example'], assign: { project: 'filament', envName: 'SPOOL_KEY' } },
    { kind: 'host' },
  )
  webhookToken = rotateWebhookToken(host, 'filament', 'scanned')
  expect((await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true })).ok).toBe(true)
  await createBranch(host, 'filament', 'more-spools')
  await workspaces.start('filament', 'more-spools')
  triggerCalls = []
})

afterEach(async () => {
  await app.close()
  await runtime.stop()
  await data.stop()
  host.dispose()
})

function renameRequest(name: string, body: unknown, headers = writeHeaders(cookie)) {
  return fetch(`${app.base}/api/projects/${name}/rename`, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function spools(project: string): Promise<unknown> {
  const outcome = await runtime.invoke(project, { kind: 'route', name: 'GET /spools', manual: true })
  if (!outcome.ok) throw new Error(outcome.error.message)
  return JSON.parse(Buffer.from(outcome.response.body!, 'base64').toString())
}

test('renaming moves the project and its data, and it runs under the new name', async () => {
  const id = requireProject(host, 'filament').id
  const workspace = workspaces.get('filament', 'more-spools')!
  writeFileSync(join(workspace.dir, 'notes.md'), 'not committed yet\n')

  const res = await renameRequest('filament', { name: 'spools' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: 'spools' })

  expect(getProject(host, 'filament')).toBeUndefined()
  expect(requireProject(host, 'spools').id).toBe(id)
  for (const path of projectPaths(host, 'filament')) expect(existsSync(path), path).toBe(false)
  expect(existsSync(join(repoPath(host, 'spools'), 'HEAD'))).toBe(true)
  expect(existsSync(join(host.dataDir, 'projects', 'spools', 'db.sqlite'))).toBe(true)

  // Everything it ran stopped and its entry points moved to the new name.
  expect(sandboxes.running.size).toBe(0)
  expect(stoppedWorkspaces).toEqual(['filament/more-spools'])
  expect(triggerCalls).toEqual(['remove filament', 'sync spools'])
  expect(runtime.crons('filament')).toEqual([])
  expect(runtime.crons('spools')).toHaveLength(1)

  expect(await spools('spools')).toEqual([{ color: 'red' }])
  expect(secrets.assigned('spools')).toMatchObject([{ envName: 'SPOOL_KEY' }])

  // The workspace kept its uncommitted file and commits to the moved repo.
  const moved = workspaces.get('spools', 'more-spools')!
  expect(readFileSync(join(moved.dir, 'notes.md'), 'utf8')).toBe('not committed yet\n')
  const commit = await workspaces.commit('spools', 'more-spools', 'Add notes')
  expect(await branchHead(host, 'spools', 'more-spools')).toBe(commit)

  const events = queryLogs(host, { project: 'spools', eventsOnly: true, limit: 100 })
  expect(events.map((line) => line.message)).toContain('Renamed from filament to spools by Kaan')
})

test('old webhook URLs, app links and project pages lead to the renamed project', async () => {
  await renameProject({ host, workspaces, delivery, runtime, data }, 'filament', 'spools')

  for (const name of ['filament', 'spools']) {
    const hook = await sendTo(app.base, `http://${name}.${TEST_APPS_DOMAIN}/_hobwork/hooks/scanned/${webhookToken}`, { method: 'POST' })
    expect(hook.status, name).toBe(200)
    expect(JSON.parse(hook.body)).toEqual({ scanned: true })
  }
  expect((await sendTo(app.base, `http://filament.${TEST_APPS_DOMAIN}/_hobwork/hooks/scanned/wrong`, { method: 'POST' })).status).toBe(404)

  const page = await sendTo(app.base, `http://filament.${TEST_APPS_DOMAIN}/shelf?x=1`)
  expect(page.status).toBe(302)
  expect(page.headers.location).toBe(`http://spools.${TEST_APPS_DOMAIN}/shelf?x=1`)
  expect((await sendTo(app.base, `http://filament.${TEST_APPS_DOMAIN}/api/spools`, { method: 'POST' })).status).toBe(404)

  const detail = await fetch(`${app.base}/api/projects/filament`, { headers: { cookie } })
  expect(await detail.json()).toMatchObject({ name: 'spools' })
  const logs = await fetch(`${app.base}/api/projects/filament/logs`, { headers: { cookie } })
  expect(logs.status).toBe(404)
  expect(await logs.json()).toEqual({ error: 'filament is now called spools' })
  expect(() => requireProject(host, 'filament')).toThrow('Hob "filament" was renamed to "spools"')
})

test('storage use and agent access follow the renamed project', async () => {
  const id = requireProject(host, 'filament').id
  const storage = createStorageUsage(host)
  await storage.measure({ id, name: 'filament' })
  const { token } = createAgentToken(host.db, 'claude', { readOnly: false, projects: ['filament'] })

  await renameProject({ host, workspaces, delivery, runtime, data, storage }, 'filament', 'spools')
  await storage.measure({ id, name: 'spools' })
  expect(storage.get({ id, name: 'spools' })?.database).toBeGreaterThan(0)
  expect(verifyAgentToken(host.db, token)!.access.projects).toEqual(['spools'])
})

test('a new project can take the old name', async () => {
  await renameProject({ host, workspaces, delivery, runtime, data }, 'filament', 'spools')
  await createProject(host, 'filament')

  const hook = await sendTo(app.base, `http://filament.${TEST_APPS_DOMAIN}/_hobwork/hooks/scanned/${webhookToken}`, { method: 'POST' })
  expect(hook.status).toBe(404)
  const detail = await fetch(`${app.base}/api/projects/filament`, { headers: { cookie } })
  expect(await detail.json()).toMatchObject({ name: 'filament' })

  // Renaming back takes the name from the alias of the other project.
  await renameProject({ host, workspaces, delivery, runtime, data }, 'filament', 'filament-new')
  await renameProject({ host, workspaces, delivery, runtime, data }, 'spools', 'filament')
  expect(await spools('filament')).toEqual([{ color: 'red' }])
  const aliases = host.db.prepare('SELECT name FROM project_renames ORDER BY name').all().map((row) => row.name)
  expect(aliases).toEqual(['spools'])
})

test('renaming refuses invalid and taken names and needs a signed-in person', async () => {
  await createProject(host, 'sleep')
  expect((await renameRequest('filament', { name: 'sleep' })).status).toBe(409)
  expect((await renameRequest('filament', { name: 'Filament!' })).status).toBe(409)
  expect((await renameRequest('filament', { name: 'filament' })).status).toBe(409)
  expect((await renameRequest('filament', {})).status).toBe(400)
  expect((await renameRequest('nope', { name: 'other' })).status).toBe(404)
  const { token } = createAgentToken(host.db, 'claude')
  const agent = await renameRequest('filament', { name: 'spools' }, {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  })
  expect(agent.status).toBe(401)
  const noCsrf = await renameRequest('filament', { name: 'spools' }, { cookie, 'content-type': 'application/json' })
  expect(noCsrf.status).toBe(403)

  expect(getProject(host, 'filament')).toBeDefined()
  expect(sandboxes.running.size).toBe(1)
  expect(runtime.crons('filament')).toHaveLength(1)
})

test('a failed rename leaves the project as it was', async () => {
  const blocked = join(host.dataDir, 'builds', 'spools')
  mkdirSync(blocked, { recursive: true })
  await expect(renameProject({ host, workspaces, delivery, runtime, data }, 'filament', 'spools')).rejects.toThrow(
    'Hobwork still has files',
  )
  expect(getProject(host, 'filament')).toBeDefined()
  for (const path of projectPaths(host, 'filament').slice(0, 2)) expect(existsSync(path), path).toBe(true)
  expect(runtime.crons('filament')).toHaveLength(1)
  expect(await spools('filament')).toEqual([{ color: 'red' }])
})

test('agents have no MCP tool that renames or restores a project', async () => {
  const mcp = await startTestMcp()
  try {
    const { tools } = await mcp.client.listTools()
    expect(tools.filter((tool) => /rename|restore_project|trash/.test(tool.name))).toEqual([])
  } finally {
    await mcp.close()
  }
})
