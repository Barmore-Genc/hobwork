import { existsSync, mkdirSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDelivery } from '../delivery.ts'
import { repoPath } from '../host.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, getProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { recordVersion } from '../versions.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from '../workspaces.ts'
import { cleanupBuilds, removeOrphanBuilds } from './build-cleanup.ts'
import { projectBuildsDir, treeOf } from './builds.ts'
import { createRuntime, type Runtime, type RuntimeOptions } from './runtime.ts'
import { fakeRuntimeSandboxes, type FakeRuntimeSandboxes } from './test-sandbox.ts'

vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>
let sandboxes: FakeRuntimeSandboxes
let runtime: Runtime
let builds: number

function start(options: Partial<RuntimeOptions> = {}) {
  runtime = createRuntime(host, {
    createSandbox: sandboxes.factory,
    image: '/nonexistent-image',
    startBuildVm: async (vm) => {
      builds++
      return startHostPipelineVm(vm)
    },
    ...options,
  })
}

// Each release answers with its own number, so every version has its own tree.
async function deploy(n: number): Promise<{ version: number; commit: string }> {
  const commit = await seedMain(host, 'filament', {
    'package.json': fakePackageJson({ build: 'mkdir -p dist/handlers/src && cp handlers/*.js dist/handlers/src/' }),
    'hobwork.json': JSON.stringify({ routes: { 'GET /n': { handler: 'src/n.ts' } } }),
    'handlers/n.js': `export default async () => ${n}`,
  })
  const version = recordVersion(host, { projectId: getProject(host, 'filament')!.id, commit, summary: `Release ${n}` })
  await runtime.deploy({ project: 'filament', version: version.number, commit, reason: 'merge' })
  return { version: version.number, commit }
}

function storedTrees(): string[] {
  return readdirSync(projectBuildsDir(host, 'filament')).sort()
}

function tree(commit: string): Promise<string> {
  return treeOf(repoPath(host, 'filament'), commit)
}

// Makes every stored build look older than the minimum age.
function age() {
  const old = new Date(Date.now() - 2 * 3600_000)
  for (const entry of storedTrees()) utimesSync(join(projectBuildsDir(host, 'filament'), entry), old, old)
}

async function answer(): Promise<unknown> {
  const outcome = await runtime.invoke('filament', { kind: 'route', name: 'GET /n', manual: true })
  if (!outcome.ok) throw new Error(outcome.error.message)
  return JSON.parse(Buffer.from(outcome.response.body, 'base64').toString())
}

beforeEach(async () => {
  host = createTestHost()
  sandboxes = fakeRuntimeSandboxes()
  builds = 0
  await createProject(host, 'filament')
})

afterEach(async () => {
  await runtime?.stop()
  host.dispose()
})

test('keeps the builds of the newest versions and of running VMs, and recent ones', async () => {
  start()
  const releases = []
  for (let n = 1; n <= 4; n++) releases.push(await deploy(n))
  expect(storedTrees()).toHaveLength(4)

  expect(await cleanupBuilds(host, 'filament', { keepVersions: 2 })).toEqual([])
  age()
  const removed = await cleanupBuilds(host, 'filament', { keepVersions: 2, inUse: [releases[0]!.commit] })
  expect(removed).toEqual([await tree(releases[1]!.commit)])
  expect(storedTrees()).toEqual(
    (await Promise.all([releases[0]!, releases[2]!, releases[3]!].map((r) => tree(r.commit)))).sort(),
  )
})

test('a deploy removes old builds, and a restore of a version without its build builds it again', async () => {
  start({ buildRetention: { keepVersions: 2, minAgeMs: 60_000 } })
  const first = await deploy(1)
  await deploy(2)
  age()
  await deploy(3)
  expect(storedTrees()).not.toContain(await tree(first.commit))
  expect(storedTrees()).toHaveLength(2)
  expect(builds).toBe(3)

  const delivery = createDelivery(host, { workspaces: createWorkspaceManager<ExecWorkspaceVm>(host), deploy: runtime.deploy })
  const restored = await delivery.restore({ project: 'filament', version: first.version })
  expect(restored.deployError).toBeUndefined()
  expect(builds).toBe(4)
  expect(storedTrees()).toContain(await tree(first.commit))
  expect(await answer()).toBe(1)
})

test('builds of projects that no longer exist are removed', async () => {
  mkdirSync(join(host.dataDir, 'builds', 'gone', 'abc'), { recursive: true })
  mkdirSync(join(host.dataDir, 'builds', 'filament', 'abc'), { recursive: true })
  expect(removeOrphanBuilds(host)).toEqual(['gone'])
  expect(existsSync(join(host.dataDir, 'builds', 'filament', 'abc'))).toBe(true)
})
