import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { workspaceDir } from './host.ts'
import { createProject } from './projects.ts'
import { createBranch, diffBranch, listBranches, log, validateBranchName } from './repo.ts'
import { createTestHost } from './test-host.ts'
import { ensureAgent } from './agents.ts'
import { startHostWorkspaceVm } from './test-workspace-vm.ts'
import { createWorkspaceManager, type Workspace } from './workspaces.ts'

const noExec = async () => ({ exitCode: 0, stdout: '', stderr: '' })

let host: ReturnType<typeof createTestHost>

beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
})

afterEach(() => {
  host.dispose()
})

test.each(['feature', 'feature/spools', 'fix-1.2', 'a_b'])('accepts branch %s', (name) => {
  expect(() => validateBranchName(name)).not.toThrow()
})

test.each(['', '-x', 'a..b', 'a/', '/a', 'a//b', 'a.lock', 'a.', 'a b', 'a~1', 'a:b', '.a'])(
  'rejects branch %j',
  (name) => {
    expect(() => validateBranchName(name)).toThrow('Invalid branch name')
  },
)

test('creates, lists and deletes branches', async () => {
  const workspaces = createWorkspaceManager(host)
  const main = (await listBranches(host, 'filament'))[0]
  const branch = await createBranch(host, 'filament', 'feature/spools')
  expect(branch).toMatchObject({ name: 'feature/spools', sha: main?.sha })
  expect((await listBranches(host, 'filament')).map((b) => b.name)).toEqual(['feature/spools', 'main'])
  await expect(createBranch(host, 'filament', 'feature/spools')).rejects.toThrow('already exists')

  await workspaces.open('filament', 'feature/spools')
  await workspaces.deleteBranch('filament', 'feature/spools')
  expect((await listBranches(host, 'filament')).map((b) => b.name)).toEqual(['main'])
  expect(workspaces.list('filament')).toEqual([])
  expect(existsSync(workspaceDir(host, 'filament', 'feature/spools'))).toBe(false)
})

test('main cannot be created or deleted as a branch', async () => {
  await expect(createBranch(host, 'filament', 'main')).rejects.toThrow('merging')
  await expect(createWorkspaceManager(host).deleteBranch('filament', 'main')).rejects.toThrow('merging')
})

test('rejects refs that look like options', async () => {
  await expect(createBranch(host, 'filament', 'x', '--output=/tmp/x')).rejects.toThrow('Unknown ref')
  await expect(log(host, 'filament', '--all')).rejects.toThrow('Unknown ref')
})

test('checks out a branch, commits, and shows diff and log', async () => {
  const workspaces = createWorkspaceManager(host, { startVm: startHostWorkspaceVm(host) })
  const agent = ensureAgent(host.db, 'Agent')
  await createBranch(host, 'filament', 'spools')
  const workspace = await workspaces.open('filament', 'spools')
  expect(workspace).toMatchObject({ project: 'filament', branch: 'spools', status: 'stopped' })
  expect(readFileSync(join(workspace.dir, 'hobwork.json'), 'utf8')).toContain('routes')
  expect(existsSync(join(workspace.dir, '.git'))).toBe(false)
  expect(readFileSync(join(workspace.gitDir, 'config'), 'utf8')).not.toContain('origin')

  expect(await workspaces.commit('filament', 'spools', 'Nothing', agent)).toBeUndefined()

  writeFileSync(join(workspace.dir, 'src', 'spools.ts'), 'export const spools = 3\n')
  const diff = await workspaces.diff('filament', 'spools')
  expect(diff).toContain('+++ b/src/spools.ts')
  expect(diff).toContain('+export const spools = 3')

  expect(await workspaces.changes('filament', 'spools')).toEqual(['A  src/spools.ts'])
  const sha = await workspaces.commit('filament', 'spools', 'Add spools', agent)
  expect(sha).toMatch(/^[0-9a-f]{40}$/)
  expect(await workspaces.diff('filament', 'spools')).toBe('')
  expect(await workspaces.changes('filament', 'spools')).toEqual([])
  expect(await workspaces.isCommitted('filament', 'spools')).toBe(true)

  const commits = await log(host, 'filament', 'spools')
  expect(commits[0]).toMatchObject({ sha, author: 'Agent', subject: 'Add spools' })
  expect(commits[1]?.subject).toBe('Create hob from template')
  expect(await diffBranch(host, 'filament', 'spools')).toContain('+export const spools = 3')
  expect(await log(host, 'filament')).toHaveLength(1)
})

test('opening a missing branch fails', async () => {
  await expect(createWorkspaceManager(host).open('filament', 'nope')).rejects.toThrow('does not exist')
})

test('starts and stops a workspace VM through the seam', async () => {
  const stop = vi.fn(async () => {})
  const startVm = vi.fn(async (workspace: Workspace) => ({ workspace, stop, exec: noExec }))
  const workspaces = createWorkspaceManager(host, { startVm })
  await createBranch(host, 'filament', 'vm')

  const [a, b] = await Promise.all([workspaces.start('filament', 'vm'), workspaces.start('filament', 'vm')])
  expect(a).toBe(b)
  expect(startVm).toHaveBeenCalledOnce()
  expect(a.workspace.dir).toBe(join(workspaceDir(host, 'filament', 'vm'), 'files'))
  expect(workspaces.get('filament', 'vm')?.status).toBe('running')

  await workspaces.stop('filament', 'vm')
  expect(stop).toHaveBeenCalledOnce()
  expect(workspaces.get('filament', 'vm')?.status).toBe('stopped')
})

test('a failed VM start leaves the workspace stopped', async () => {
  const workspaces = createWorkspaceManager(host, {
    startVm: async () => {
      throw new Error('boom')
    },
  })
  await createBranch(host, 'filament', 'vm')
  await expect(workspaces.start('filament', 'vm')).rejects.toThrow('boom')
  expect(workspaces.get('filament', 'vm')?.status).toBe('stopped')
})

test('start without a sandbox fails clearly', async () => {
  await createBranch(host, 'filament', 'vm')
  await expect(createWorkspaceManager(host).start('filament', 'vm')).rejects.toThrow('not available')
})

function testVm() {
  const vm = { busy: false, stale: false, stopped: false }
  return {
    vm,
    handle: {
      exec: noExec,
      stop: async () => {
        vm.stopped = true
      },
      busy: () => vm.busy,
      isStale: () => vm.stale,
    },
  }
}

test('stops VMs that were not used for the idle timeout', async () => {
  const started: ReturnType<typeof testVm>['vm'][] = []
  const workspaces = createWorkspaceManager(host, {
    idleTimeoutMs: 60_000,
    startVm: async () => {
      const { vm, handle } = testVm()
      started.push(vm)
      return handle
    },
  })
  await createBranch(host, 'filament', 'a')
  await createBranch(host, 'filament', 'b')
  await workspaces.start('filament', 'a')
  await workspaces.start('filament', 'b')
  const lastUsed = Date.parse(workspaces.get('filament', 'a')?.lastUsedAt ?? '')

  await workspaces.stopIdle(lastUsed + 30_000)
  expect(started.map((vm) => vm.stopped)).toEqual([false, false])

  started[1]!.busy = true
  await workspaces.stopIdle(lastUsed + 120_000)
  expect(started.map((vm) => vm.stopped)).toEqual([true, false])
  expect(workspaces.get('filament', 'a')?.status).toBe('stopped')
  expect(workspaces.get('filament', 'b')?.status).toBe('running')

  await workspaces.stopAll()
  expect(started[1]?.stopped).toBe(true)
  expect(workspaces.get('filament', 'b')?.status).toBe('stopped')
})

test('the idle check runs on its own', async () => {
  const { vm, handle } = testVm()
  const workspaces = createWorkspaceManager(host, { idleTimeoutMs: 50, startVm: async () => handle })
  await createBranch(host, 'filament', 'vm')
  await workspaces.start('filament', 'vm')
  await vi.waitFor(() => expect(vm.stopped).toBe(true), { timeout: 2000 })
  expect(workspaces.get('filament', 'vm')?.status).toBe('stopped')
})

test('a stale VM is replaced on the next start unless it is busy', async () => {
  const started: ReturnType<typeof testVm>[] = []
  const workspaces = createWorkspaceManager(host, {
    startVm: async () => {
      const vm = testVm()
      started.push(vm)
      return vm.handle
    },
  })
  await createBranch(host, 'filament', 'vm')
  const first = await workspaces.start('filament', 'vm')
  started[0]!.vm.stale = true
  started[0]!.vm.busy = true
  expect(await workspaces.start('filament', 'vm')).toBe(first)

  started[0]!.vm.busy = false
  const second = await workspaces.start('filament', 'vm')
  expect(second).not.toBe(first)
  expect(started[0]?.vm.stopped).toBe(true)
  expect(workspaces.get('filament', 'vm')?.status).toBe('running')
})

test('tracks whether the checkout has uncommitted changes', async () => {
  const workspaces = createWorkspaceManager(host, { startVm: startHostWorkspaceVm(host) })
  const agent = ensureAgent(host.db, 'Agent')
  await createBranch(host, 'filament', 'dirty')
  expect(await workspaces.isCommitted('filament', 'dirty')).toBe(true)

  const workspace = await workspaces.open('filament', 'dirty')
  expect(await workspaces.isCommitted('filament', 'dirty')).toBe(true)

  await workspaces.files('filament', 'dirty', { op: 'write', path: 'notes.txt', content: 'hi\n' })
  expect(await workspaces.isCommitted('filament', 'dirty')).toBe(false)
  expect(readFileSync(join(workspace.dir, 'notes.txt'), 'utf8')).toBe('hi\n')

  await workspaces.commit('filament', 'dirty', 'Add notes', agent)
  expect(await workspaces.isCommitted('filament', 'dirty')).toBe(true)

  const session = workspaces.openSession('filament', 'dirty', agent)
  expect(await workspaces.isCommitted('filament', 'dirty')).toBe(false)
  await workspaces.changes('filament', 'dirty')
  expect(await workspaces.isCommitted('filament', 'dirty')).toBe(false)
  session.close()
})

test('commits without a workspace do nothing and do not start a VM', async () => {
  const startVm = vi.fn(async (workspace: Workspace) => ({ workspace, stop: async () => {}, exec: noExec }))
  const workspaces = createWorkspaceManager(host, { startVm })
  const agent = ensureAgent(host.db, 'Agent')
  await createBranch(host, 'filament', 'none')
  expect(await workspaces.commit('filament', 'none', 'Nothing', agent)).toBeUndefined()
  expect(await workspaces.diff('filament', 'none')).toBe('')
  expect(await workspaces.changes('filament', 'none')).toEqual([])
  expect(startVm).not.toHaveBeenCalled()
})

test('file tools need a workspace VM', async () => {
  await createBranch(host, 'filament', 'novm')
  await expect(
    createWorkspaceManager(host).files('filament', 'novm', { op: 'write', path: 'a.txt', content: 'x' }),
  ).rejects.toThrow('not available')
})
