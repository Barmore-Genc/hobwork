import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken } from './agents.ts'
import { createProjectData, type ProjectData } from './data/project-data.ts'
import { createDelivery, type Delivery } from './delivery.ts'
import type { TriggerRegistry } from './homeassistant/triggers.ts'
import { repoPath } from './host.ts'
import { runHousekeeping } from './housekeeping.ts'
import { startTestMcp } from './mcp/test-mcp.ts'
import { deleteProject, purgeTrash, trashDir, type TrashEntry, type TrashInfo } from './project-deletion.ts'
import { createProject, getProject } from './projects.ts'
import { createBranch } from './repo.ts'
import { startHostPipelineVm } from './pipeline/host-backend.ts'
import { projectBuildsDir } from './runtime/builds.ts'
import { createRuntime, type Runtime } from './runtime/runtime.ts'
import { fakeRuntimeSandboxes, type FakeRuntimeSandboxes } from './runtime/test-sandbox.ts'
import { rotateWebhookToken } from './runtime/webhooks.ts'
import { createSecretStore, type SecretStore } from './secrets.ts'
import { createTestHost } from './test-host.ts'
import { fakePackageJson, seedMain } from './test-project.ts'
import { signedIn, startTestApp, writeHeaders } from './test-web.ts'
import { recordVersion } from './versions.ts'
import { createWorkspaceManager, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

vi.setConfig({ testTimeout: 30_000 })

const HOBWORK_JSON = {
  routes: { 'GET /spools': { handler: 'src/spools.ts' } },
  crons: { tick: { schedule: '0 8 * * *', handler: 'src/tick.ts' } },
  webhooks: { scanned: { handler: 'src/scanned.ts' } },
  triggers: { desk: { homeassistant: { trigger: 'state', entity_id: 'input_button.desk' }, handler: 'src/desk.ts' } },
}

const FILES = {
  'package.json': fakePackageJson({ build: 'mkdir -p dist/handlers/src && cp handlers/*.js dist/handlers/src/' }),
  'hobwork.json': JSON.stringify(HOBWORK_JSON),
  'migrations/0001_spools.sql': 'CREATE TABLE spools (id INTEGER PRIMARY KEY, color TEXT) STRICT;',
  'handlers/spools.js': `export default async (ctx) => ctx.db.query('SELECT * FROM spools')`,
  'handlers/tick.js': `export default async (ctx) => { await ctx.db.run("INSERT INTO spools (color) VALUES ('red')"); console.log('ticked') }`,
  'handlers/scanned.js': 'export default async () => undefined',
  'handlers/desk.js': 'export default async () => undefined',
}

const TABLES = ['versions', 'invocations', 'logs', 'webhook_tokens', 'workspaces', 'pipeline_runs', 'secret_assignments']

let host: ReturnType<typeof createTestHost>
let sandboxes: FakeRuntimeSandboxes
let runtime: Runtime
let data: ProjectData
let secrets: SecretStore
let delivery: Delivery
let workspaces: WorkspaceManager<ExecWorkspaceVm>
let app: Awaited<ReturnType<typeof startTestApp>>
let removedTriggers: string[]
let stoppedWorkspaces: string[]
let cookie: string

function projectId(name: string): number {
  return getProject(host, name)!.id
}

function rowCounts(id: number): Record<string, number> {
  return Object.fromEntries(
    TABLES.map((table) => [table, Number(host.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`).get(id)!.n)]),
  )
}

async function release(name: string) {
  const commit = await seedMain(host, name, FILES)
  const version = recordVersion(host, { projectId: projectId(name), commit, summary: 'Track spools' })
  await runtime.deploy({ project: name, version: version.number, commit, reason: 'merge' })
}

beforeEach(async () => {
  host = createTestHost()
  sandboxes = fakeRuntimeSandboxes()
  removedTriggers = []
  stoppedWorkspaces = []
  const triggers: TriggerRegistry = {
    syncProjectTriggers: async () => [],
    removeProject: async (project) => {
      removedTriggers.push(project)
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
  await createProject(host, 'sleep')
  await release('filament')
  await release('sleep')
  secrets.create(
    { name: 'Spool API', value: 'x', hosts: ['api.spools.example'], assign: { project: 'filament', envName: 'SPOOL_KEY' } },
    { kind: 'host' },
  )
  rotateWebhookToken(host, 'filament', 'scanned')
  expect((await runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true })).ok).toBe(true)
  await createBranch(host, 'filament', 'more-spools')
  await workspaces.start('filament', 'more-spools')
  host.db
    .prepare("INSERT INTO pipeline_runs (project_id, branch, commit_sha, status) VALUES (?, 'more-spools', 'abc', 'passed')")
    .run(projectId('filament'))
})

afterEach(async () => {
  await app.close()
  await runtime.stop()
  await data.stop()
  host.dispose()
})

function deleteRequest(name: string, body: unknown, headers = writeHeaders(cookie)) {
  return fetch(`${app.base}/api/projects/${name}`, { method: 'DELETE', headers, body: JSON.stringify(body) })
}

test('deleting a project stops everything it runs and removes it, keeping its repo and DB in the trash', async () => {
  const id = projectId('filament')
  expect(Object.values(rowCounts(id)).every((n) => n > 0)).toBe(true)
  expect(sandboxes.running.size).toBe(2)
  expect(runtime.crons('filament')).toHaveLength(1)

  const res = await deleteRequest('filament', { confirm: 'filament' })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ deleted: 'filament', trashDays: 7 })

  expect(getProject(host, 'filament')).toBeUndefined()
  expect(rowCounts(id)).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])))
  expect([...sandboxes.running].map((s) => s.options.label)).toEqual([expect.stringContaining('runtime sleep')])
  expect(stoppedWorkspaces).toEqual(['filament/more-spools'])
  expect(removedTriggers).toEqual(['filament'])
  expect(runtime.crons('filament')).toEqual([])
  expect(secrets.list()).toMatchObject([{ name: 'Spool API', assignments: [] }])
  for (const path of [
    repoPath(host, 'filament'),
    projectBuildsDir(host, 'filament'),
    join(host.dataDir, 'workspaces', 'filament'),
    join(host.dataDir, 'projects', 'filament'),
  ]) {
    expect(existsSync(path), path).toBe(false)
  }
  await expect(runtime.invoke('filament', { kind: 'cron', name: 'tick', manual: true })).rejects.toThrow('no deployed version')

  const entries = readdirSync(trashDir(host))
  expect(entries).toEqual([expect.stringMatching(/^filament-\d{8}T\d{6}Z$/)])
  const entry = join(trashDir(host), entries[0]!)
  expect(existsSync(join(entry, 'repo.git', 'HEAD'))).toBe(true)
  expect(existsSync(join(entry, 'data', 'db.sqlite'))).toBe(true)
  const info = JSON.parse(readFileSync(join(entry, 'deleted.json'), 'utf8')) as TrashInfo
  expect(info).toMatchObject({ project: 'filament', deletedBy: 'kaan@example.com' })
  expect(info.versions.map((v) => v.summary)).toEqual(['Track spools', 'Create project from template'])

  const sleep = await runtime.invoke('sleep', { kind: 'cron', name: 'tick', manual: true })
  expect(sleep.ok).toBe(true)
})

test('the name can be used again right after deleting', async () => {
  await deleteProject({ host, workspaces, delivery, runtime, data }, 'filament')
  await createProject(host, 'filament')
  await release('filament')
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'GET /spools', manual: true })
  expect(outcome.ok && JSON.parse(Buffer.from(outcome.response.body, 'base64').toString())).toEqual([])
})

test('deleting a project drops its storage use', async () => {
  const id = projectId('filament')
  const forget = vi.fn()
  await deleteProject({ host, workspaces, delivery, runtime, data, storage: { forget } }, 'filament')
  expect(forget).toHaveBeenCalledWith(id)
})

test('deleting needs the project name typed and a signed-in user', async () => {
  expect((await deleteRequest('filament', { confirm: 'filamen' })).status).toBe(400)
  expect((await deleteRequest('filament', {})).status).toBe(400)
  expect((await deleteRequest('nope', { confirm: 'nope' })).status).toBe(404)
  const { token } = createAgentToken(host.db, 'claude')
  const agent = await deleteRequest('filament', { confirm: 'filament' }, {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  })
  expect(agent.status).toBe(401)
  const noCsrf = await deleteRequest('filament', { confirm: 'filament' }, { cookie, 'content-type': 'application/json' })
  expect(noCsrf.status).toBe(403)
  expect(getProject(host, 'filament')).toBeDefined()
  expect(sandboxes.running.size).toBe(2)
})

test('agents have no MCP tool that deletes a project', async () => {
  const mcp = await startTestMcp()
  try {
    const { tools } = await mcp.client.listTools()
    expect(tools.length).toBeGreaterThan(10)
    expect(tools.filter((tool) => /delete|remove/.test(tool.name)).map((tool) => tool.name)).toEqual(['delete_file'])
  } finally {
    await mcp.close()
  }
})

test('the trash keeps a deleted project for 7 days', async () => {
  const now = Date.now()
  await deleteProject({ host, workspaces, delivery, runtime, data, now: () => now }, 'filament')
  expect(purgeTrash(host, now + 6 * 24 * 3600_000)).toEqual([])
  await runHousekeeping(host, runtime, now + 6.9 * 24 * 3600_000)
  expect(readdirSync(trashDir(host))).toHaveLength(1)
  await runHousekeeping(host, runtime, now + 7 * 24 * 3600_000 + 1)
  expect(readdirSync(trashDir(host))).toEqual([])
})

test('a deletion waits for a running merge or restore of the project', async () => {
  let finishRestore!: () => void
  const restoring = delivery.exclusive('filament', () => new Promise<void>((resolve) => (finishRestore = resolve)))
  const deleting = deleteProject({ host, workspaces, delivery, runtime, data }, 'filament')
  await new Promise((r) => setTimeout(r, 50))
  expect(getProject(host, 'filament')).toBeDefined()
  finishRestore()
  await restoring
  await deleting
  expect(getProject(host, 'filament')).toBeUndefined()
})

function trashList(): Promise<{ trashDays: number; projects: TrashEntry[] }> {
  return fetch(`${app.base}/api/trash`, { headers: { cookie } }).then((res) => res.json() as never)
}

function restoreRequest(id: string, body: unknown = {}, headers = writeHeaders(cookie)) {
  return fetch(`${app.base}/api/trash/${id}/restore`, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function spools(project: string): Promise<unknown> {
  const outcome = await runtime.invoke(project, { kind: 'route', name: 'GET /spools', manual: true })
  if (!outcome.ok) throw new Error(outcome.error.message)
  return JSON.parse(Buffer.from(outcome.response.body!, 'base64').toString())
}

test('the trash lists deleted projects with who deleted them and when they are removed', async () => {
  const now = Date.parse('2026-09-20T10:00:00Z')
  await deleteProject({ host, workspaces, delivery, runtime, data, now: () => now }, 'filament', { user: signedIn(host).user })
  const { trashDays, projects } = await trashList()
  expect(trashDays).toBe(7)
  expect(projects).toEqual([
    {
      id: 'filament-20260920T100000Z',
      project: 'filament',
      deletedAt: '2026-09-20T10:00:00.000Z',
      purgeAfter: '2026-09-27T10:00:00.000Z',
      deletedBy: 'kaan@example.com',
      versions: 2,
      lastVersion: { number: 2, summary: 'Track spools', createdAt: expect.any(String) },
      nameTaken: false,
    },
  ])
  await createProject(host, 'filament')
  expect((await trashList()).projects[0]!.nameTaken).toBe(true)
})

test('restoring brings a deleted project back as it was', async () => {
  const token = rotateWebhookToken(host, 'filament', 'scanned')
  host.db.prepare("INSERT INTO nfc_tags (id, project_id) VALUES ('tag-1', ?)").run(projectId('filament'))
  const before = rowCounts(projectId('filament'))
  await deleteProject({ host, workspaces, delivery, runtime, data }, 'filament')
  const [entry] = (await trashList()).projects

  const res = await restoreRequest(entry!.id)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: 'filament' })

  const after = rowCounts(projectId('filament'))
  for (const table of ['versions', 'secret_assignments', 'webhook_tokens']) expect(after[table], table).toBe(before[table])
  expect(host.db.prepare('SELECT project_id FROM nfc_tags WHERE id = ?').get('tag-1')).toEqual({ project_id: projectId('filament') })
  expect(secrets.assigned('filament')).toMatchObject([{ envName: 'SPOOL_KEY' }])
  expect((await trashList()).projects).toEqual([])
  expect(readdirSync(trashDir(host))).toEqual([])

  expect(runtime.crons('filament')).toHaveLength(1)
  expect(await spools('filament')).toEqual([{ id: 1, color: 'red' }])
  const hook = await fetch(`${app.base}/hooks/filament/scanned/${token}`, { method: 'POST' })
  expect(hook.status).toBe(204)
})

test('a deleted project whose name is taken is restored under another name', async () => {
  await deleteProject({ host, workspaces, delivery, runtime, data }, 'filament')
  await createProject(host, 'filament')
  const [entry] = (await trashList()).projects

  const taken = await restoreRequest(entry!.id)
  expect(taken.status).toBe(409)
  expect(await taken.json()).toEqual({ error: 'There is already a project called "filament"' })
  expect((await restoreRequest(entry!.id, { name: 'sleep' })).status).toBe(409)

  const res = await restoreRequest(entry!.id, { name: 'old-filament' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: 'old-filament' })
  expect(existsSync(join(host.dataDir, 'projects', 'old-filament', 'db.sqlite'))).toBe(true)
  expect(runtime.crons('old-filament')).toHaveLength(1)
  expect(await spools('old-filament')).toEqual([{ id: 1, color: 'red' }])
})

test('restoring needs a signed-in person and an entry still in the trash', async () => {
  await deleteProject({ host, workspaces, delivery, runtime, data }, 'filament')
  const [entry] = (await trashList()).projects
  const { token } = createAgentToken(host.db, 'claude')
  const agent = await restoreRequest(entry!.id, {}, { authorization: `Bearer ${token}`, 'content-type': 'application/json' })
  expect(agent.status).toBe(401)
  expect((await fetch(`${app.base}/api/trash`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
  expect((await restoreRequest('..')).status).toBe(404)
  expect((await restoreRequest('filament-20200101T000000Z')).status).toBe(404)
  expect(getProject(host, 'filament')).toBeUndefined()
})
