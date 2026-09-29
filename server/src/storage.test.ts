import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { repoPath, workspaceDir } from './host.ts'
import { startTestMcp, textOf } from './mcp/test-mcp.ts'
import { createProject, getProject, type Project } from './projects.ts'
import { projectBuildsDir } from './runtime/builds.ts'
import { appendLog, finishInvocation, startInvocation } from './runtime/logs.ts'
import { createStorageUsage, measureStorage } from './storage.ts'
import { createTestHost } from './test-host.ts'
import { signedIn, startTestApp } from './test-web.ts'

vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>

beforeEach(() => {
  host = createTestHost()
})

afterEach(() => {
  host.dispose()
})

function write(path: string, bytes: number) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes))
}

function addProject(name: string): Project {
  host.db.prepare("INSERT INTO projects (name, default_branch) VALUES (?, 'main')").run(name)
  return getProject(host, name)!
}

test('measures each part of a project', async () => {
  const project = await createProject(host, 'filament')
  write(join(host.dataDir, 'projects', 'filament', 'db.sqlite'), 4096)
  write(join(host.dataDir, 'projects', 'filament', 'db.sqlite-wal'), 1000)
  const branch = workspaceDir(host, 'filament', 'feature/spools')
  write(join(branch, 'db.sqlite'), 2048)
  write(join(branch, 'db.sqlite-wal'), 100)
  write(join(branch, 'files', 'src', 'spools.ts'), 300)
  write(join(branch, 'git', 'HEAD'), 20)
  write(join(projectBuildsDir(host, 'filament'), 'abc', 'handlers', 'spools.js'), 500)
  write(join(projectBuildsDir(host, 'filament'), 'def', 'index.html'), 50)
  appendLog(host, { project: 'filament', source: 'handler', level: 'info', message: 'héllo' })
  const invocation = startInvocation(host, { project: 'filament', version: 1, kind: 'cron', name: 'tick', manual: false })
  finishInvocation(host, invocation, { status: 'error', durationMs: 1, error: 'boom', stack: 'at x' })

  const use = await measureStorage(host, project, new Date('2026-09-29T10:00:00Z'))
  expect(use).toMatchObject({
    database: 5096,
    branchDatabases: 2148,
    workspaces: 320,
    builds: 550,
    logs: 6 + 4 + 4,
    measuredAt: '2026-09-29T10:00:00.000Z',
  })
  expect(use.repo).toBeGreaterThan(0)
  expect(use.total).toBe(5096 + 2148 + 320 + 550 + 14 + use.repo)
})

test('counts other projects and symlinked files as nothing', async () => {
  const project = addProject('filament')
  addProject('filament-two')
  write(join(host.dataDir, 'projects', 'filament-two', 'db.sqlite'), 4096)
  appendLog(host, { project: 'filament-two', source: 'handler', level: 'info', message: 'other' })
  write(join(host.dataDir, 'outside'), 10_000)
  mkdirSync(join(projectBuildsDir(host, 'filament'), 'abc'), { recursive: true })
  symlinkSync(join(host.dataDir, 'outside'), join(projectBuildsDir(host, 'filament'), 'abc', 'link'))
  symlinkSync(host.dataDir, join(projectBuildsDir(host, 'filament'), 'loop'))

  expect(await measureStorage(host, project)).toMatchObject({
    total: 0,
    database: 0,
    branchDatabases: 0,
    workspaces: 0,
    repo: 0,
    builds: 0,
    logs: 0,
  })
})

test('answers from the cache and measures in the background when missing or stale', async () => {
  let now = Date.parse('2026-09-29T10:00:00Z')
  const storage = createStorageUsage(host, { maxAgeMs: 60_000, now: () => now })
  const project = addProject('filament')
  const db = join(host.dataDir, 'projects', 'filament', 'db.sqlite')
  write(db, 100)

  expect(storage.get(project)).toBeNull()
  await vi.waitFor(() => expect(storage.get(project)?.database).toBe(100))

  write(db, 200)
  now += 30_000
  expect(storage.get(project)?.database).toBe(100)
  await storage.measureAll([])
  expect(storage.get(project)).toBeNull()

  await storage.measure(project)
  expect(storage.get(project)?.database).toBe(200)
  write(db, 300)
  now += 60_000
  expect(storage.get(project)?.database).toBe(200)
  await vi.waitFor(() => expect(storage.get(project)?.database).toBe(300))
})

test('keeps numbers across a rename and measures the new name', async () => {
  const storage = createStorageUsage(host)
  const project = addProject('filament')
  write(repoPath(host, 'filament') + '/HEAD', 10)
  await storage.measure(project)

  host.db.prepare("UPDATE projects SET name = 'spools' WHERE id = ?").run(project.id)
  write(repoPath(host, 'spools') + '/HEAD', 25)
  const renamed = getProject(host, 'spools')!
  expect(storage.get(renamed)?.repo).toBe(10)
  await storage.measure(renamed)
  expect(storage.get(renamed)?.repo).toBe(25)

  storage.forget(project.id)
  expect(storage.get(renamed)).toBeNull()
  await storage.measure(renamed)
})

test('the projects API and MCP tools show storage use', async () => {
  const storage = createStorageUsage(host)
  const project = await createProject(host, 'filament')
  write(join(host.dataDir, 'projects', 'filament', 'db.sqlite'), 4096)
  await storage.measure(project)
  const app = await startTestApp(host, { storage })
  try {
    const { cookie } = signedIn(host)
    const list: any = await (await fetch(`${app.base}/api/projects`, { headers: { cookie } })).json()
    expect(list[0].storage).toMatchObject({ database: 4096, total: expect.any(Number) })
    const detail: any = await (await fetch(`${app.base}/api/projects/filament`, { headers: { cookie } })).json()
    expect(detail.storage).toMatchObject({ database: 4096 })
  } finally {
    await app.close()
  }
})

test('list_hobs and get_hob show storage use', async () => {
  const mcp = await startTestMcp({ storage: (h) => createStorageUsage(h) })
  try {
    await mcp.call('create_hob', { name: 'filament' })
    const first = JSON.parse(textOf(await mcp.call('list_hobs')))
    expect(first).toEqual([expect.objectContaining({ name: 'filament', storage: null })])
    await vi.waitFor(async () => {
      const [listed] = JSON.parse(textOf(await mcp.call('list_hobs')))
      expect(listed.storage.repo).toBeGreaterThan(0)
    })
    const detail = JSON.parse(textOf(await mcp.call('get_hob', { hob: 'filament' })))
    expect(detail.storage).toMatchObject({ database: 0, repo: expect.any(Number), total: expect.any(Number) })
  } finally {
    await mcp.close()
  }
})
