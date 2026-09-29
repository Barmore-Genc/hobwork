import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken, type Agent } from './agents.ts'
import { createDelivery, type Deployment } from './delivery.ts'
import { git, GitError } from './git.ts'
import { repoPath } from './host.ts'
import { startHostPipelineVm } from './pipeline/host-backend.ts'
import type { StartPipelineVm } from './pipeline/runner.ts'
import { createProject, DEFAULT_BRANCH } from './projects.ts'
import { createBranch } from './repo.ts'
import { createTestHost } from './test-host.ts'
import { fakePackageJson, seedMain, type Files } from './test-project.ts'
import { listVersions } from './versions.ts'
import { startHostWorkspaceVm } from './test-workspace-vm.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from './workspaces.ts'

vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>
let agent: Agent
let workspaces: ReturnType<typeof createWorkspaceManager<ExecWorkspaceVm>>
let deployments: Deployment[]
let vmStarts: number

const project = 'filament'

function delivery(startVm: StartPipelineVm | null = countingHostVm) {
  return createDelivery(host, {
    workspaces,
    pipeline: startVm ? { startVm } : undefined,
    deploy: async (deployment) => {
      deployments.push(deployment)
    },
  })
}

const countingHostVm: StartPipelineVm = async (options) => {
  vmStarts++
  return startHostPipelineVm(options)
}

function inRepo(args: string[]): Promise<string> {
  return git(['--git-dir', repoPath(host, project), ...args]).then((out) => out.trim())
}

async function changeBranch(branch: string, files: Files, message = `Change ${branch}`): Promise<void> {
  const { dir } = await workspaces.open(project, branch)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  await workspaces.commit(project, branch, message, agent)
}

async function branchWith(branch: string, files: Files): Promise<void> {
  await createBranch(host, project, branch)
  await changeBranch(branch, files)
}

beforeEach(async () => {
  host = createTestHost()
  agent = createAgentToken(host.db, 'claude').agent
  workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, { startVm: startHostWorkspaceVm(host) })
  deployments = []
  vmStarts = 0
  await createProject(host, project)
  await seedMain(host, project)
})

afterEach(() => host.dispose())

test('a passing merge squashes onto main, records a version, deploys and resets the branch', async () => {
  const before = await inRepo(['rev-parse', DEFAULT_BRANCH])
  await createBranch(host, project, 'spools')
  await changeBranch('spools', { 'src/spools.ts': 'export const spools = []\n' }, 'First')
  await changeBranch('spools', { 'src/spools.ts': "export const spools = ['pla']\n" }, 'Second')

  const result = await delivery().merge({ project, branch: 'spools', summary: 'Add spools\n\nTracks spools.', agent })
  if (result.status !== 'merged') throw new Error(JSON.stringify(result))

  const main = await inRepo(['rev-parse', DEFAULT_BRANCH])
  expect(result.version).toMatchObject({ number: 2, commit: main, agent: 'claude', pipelineRunId: result.run.id })
  expect(result.run.steps.map((s) => [s.name, s.status])).toEqual([
    ['validate', 'passed'],
    ['install', 'skipped'],
    ['typecheck', 'passed'],
    ['lint', 'passed'],
    ['test', 'passed'],
    ['build', 'passed'],
    ['migrations', 'skipped'],
  ])
  expect(result.run.steps.find((s) => s.name === 'test')?.output).toContain('all tests passed')
  expect(await inRepo(['rev-parse', `${main}^@`])).toBe(before)
  expect(await inRepo(['log', '-1', '--format=%an|%cn|%B', main])).toBe('claude|Hobwork|Add spools\n\nTracks spools.')
  expect(await inRepo(['show', `${main}:src/spools.ts`])).toBe("export const spools = ['pla']")
  expect(deployments).toEqual([{ project, version: 2, commit: main, reason: 'merge' }])
  expect(listVersions(host, project).map((v) => v.number)).toEqual([2, 1])

  expect(result.branchReset).toBe(true)
  expect(await inRepo(['rev-parse', 'refs/heads/spools'])).toBe(main)
  const { dir } = await workspaces.open(project, 'spools')
  expect(readFileSync(join(dir, 'src/spools.ts'), 'utf8')).toBe("export const spools = ['pla']\n")
  expect(await workspaces.diff(project, 'spools')).toBe('')

  // The branch keeps working after the reset.
  await changeBranch('spools', { 'src/spools.ts': "export const spools = ['petg']\n" })
  const again = await delivery().merge({ project, branch: 'spools', summary: 'Switch to PETG', agent })
  expect(again.status).toBe('merged')
})

test('a failing test step returns its output and leaves main untouched', async () => {
  const before = await inRepo(['rev-parse', DEFAULT_BRANCH])
  await branchWith('broken', {
    'package.json': fakePackageJson({ test: "echo 'expected 1 to be 2' >&2; exit 1" }),
  })
  const branchHead = await inRepo(['rev-parse', 'refs/heads/broken'])

  const result = await delivery().merge({ project, branch: 'broken', summary: 'Break things', agent })
  if (result.status !== 'failed') throw new Error(JSON.stringify(result))
  expect(result.run.failedStep).toBe('test')
  const step = result.run.steps.find((s) => s.name === 'test')
  expect(step?.output).toContain('expected 1 to be 2')
  expect(step?.output).toContain('exit code: 1')
  expect(result.run.steps.find((s) => s.name === 'build')?.status).toBe('skipped')

  expect(await inRepo(['rev-parse', DEFAULT_BRANCH])).toBe(before)
  expect(await inRepo(['rev-parse', 'refs/heads/broken'])).toBe(branchHead)
  expect(listVersions(host, project)).toHaveLength(1)
  expect(deployments).toEqual([])
})

test('an invalid hobwork.json fails validation before a VM starts', async () => {
  await branchWith('bad-config', { 'hobwork.json': JSON.stringify({ crons: { a: { handler: 'src/a.ts' } } }) })
  const result = await delivery().merge({ project, branch: 'bad-config', summary: 'Bad cron', agent })
  if (result.status !== 'failed') throw new Error(JSON.stringify(result))
  expect(result.run.failedStep).toBe('validate')
  expect(result.run.steps[0]?.output).toContain('/crons/a')
  expect(result.run.steps[0]?.output).toContain('schedule')
  expect(vmStarts).toBe(0)
})

test('merges a hobwork.json with comments unless vite.config.ts reads it with JSON.parse', async () => {
  const hobworkJson = '{\n  // Nothing yet.\n  "egress": ["api.example.com",],\n}\n'
  await branchWith('comments', { 'hobwork.json': hobworkJson })
  expect((await delivery().merge({ project, branch: 'comments', summary: 'Comment', agent })).status).toBe('merged')

  await branchWith('old-vite', {
    'hobwork.json': hobworkJson.replace('Nothing yet', 'Still nothing'),
    'vite.config.ts': "const config = JSON.parse(readFileSync('hobwork.json', 'utf8'))\n",
  })
  const result = await delivery().merge({ project, branch: 'old-vite', summary: 'Old vite config', agent })
  if (result.status !== 'failed') throw new Error(JSON.stringify(result))
  expect(result.run.failedStep).toBe('validate')
  expect(result.run.steps[0]?.output).toContain("import { hobworkViteConfig } from '@hobwork/sdk/vite'")
})

test('reports a rebase conflict without changing main', async () => {
  await createBranch(host, project, 'one')
  await createBranch(host, project, 'two')
  await changeBranch('one', { 'src/a.ts': 'export const a = 2\n' })
  await changeBranch('two', { 'src/a.ts': 'export const a = 3\n' })
  expect((await delivery().merge({ project, branch: 'one', summary: 'a = 2', agent })).status).toBe('merged')
  const main = await inRepo(['rev-parse', DEFAULT_BRANCH])

  const result = await delivery().merge({ project, branch: 'two', summary: 'a = 3', agent })
  if (result.status !== 'conflict') throw new Error(JSON.stringify(result))
  expect(result.files).toEqual(['src/a.ts'])
  expect(result.output).toContain('export const a = 3')
  expect(await inRepo(['rev-parse', DEFAULT_BRANCH])).toBe(main)
})

test('pushing to main is still rejected after merges', async () => {
  await branchWith('spools', { 'src/spools.ts': 'x\n' })
  await delivery().merge({ project, branch: 'spools', summary: 'Spools', agent })
  const main = await inRepo(['rev-parse', DEFAULT_BRANCH])

  const tmp = mkdtempSync(join(tmpdir(), 'hobwork-push-'))
  try {
    await git(['clone', '--quiet', repoPath(host, project), tmp])
    writeFileSync(join(tmp, 'direct.ts'), '')
    await git(['add', '--all'], { cwd: tmp })
    await git(['commit', '--quiet', '-m', 'Direct'], { cwd: tmp, env: { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } })
    const pushed = git(['push', '--quiet', 'origin', DEFAULT_BRANCH], { cwd: tmp })
    await expect(pushed).rejects.toThrow(GitError)
    await expect(pushed).rejects.toThrow('Pushing to main is not allowed')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  expect(await inRepo(['rev-parse', DEFAULT_BRANCH])).toBe(main)
})

test('restore commits the old tree as a new version on top of main', async () => {
  await branchWith('spools', { 'src/spools.ts': 'x\n' })
  const merged = await delivery().merge({ project, branch: 'spools', summary: 'Spools', agent })
  if (merged.status !== 'merged') throw new Error(JSON.stringify(merged))
  const template = listVersions(host, project).find((v) => v.number === 1)

  const { version } = await delivery().restore({ project, version: 1, agent })
  const main = await inRepo(['rev-parse', DEFAULT_BRANCH])
  expect(version).toMatchObject({ number: 3, commit: main, summary: 'Restore version 1', restoredFrom: 1 })
  expect(await inRepo(['rev-parse', `${main}^@`])).toBe(merged.version.commit)
  expect(await inRepo(['log', '-1', '--format=%s', main])).toBe('Restore version 1')
  expect(deployments.at(-1)).toEqual({ project, version: 3, commit: main, reason: 'restore' })

  expect(await inRepo(['rev-parse', `${main}^{tree}`])).toBe(await inRepo(['rev-parse', `${template?.commit}^{tree}`]))

  await expect(delivery().restore({ project, version: 1, agent })).rejects.toThrow('already has the code of version 1')
  await expect(delivery().restore({ project, version: 9, agent })).rejects.toThrow('does not exist')
})

test('merges of one project run one at a time and each lands on the previous one', async () => {
  let active = 0
  let maxActive = 0
  const startVm: StartPipelineVm = async (options) => {
    active++
    maxActive = Math.max(maxActive, active)
    const vm = await startHostPipelineVm(options)
    return {
      ...vm,
      async stop() {
        active--
        await vm.stop()
      },
    }
  }
  await branchWith('one', { 'src/one.ts': '1\n' })
  await branchWith('two', { 'src/two.ts': '2\n' })

  const shared = delivery(startVm)
  const results = await Promise.all([
    shared.merge({ project, branch: 'one', summary: 'One', agent }),
    shared.merge({ project, branch: 'two', summary: 'Two', agent }),
  ])
  expect(results.map((r) => r.status)).toEqual(['merged', 'merged'])
  expect(maxActive).toBe(1)
  expect(listVersions(host, project).map((v) => [v.number, v.summary])).toEqual([
    [3, 'Two'],
    [2, 'One'],
    [1, 'Create hob from template'],
  ])
  const files = await inRepo(['ls-tree', '-r', '--name-only', DEFAULT_BRANCH])
  expect(files).toContain('src/one.ts')
  expect(files).toContain('src/two.ts')
})

test('refuses uncommitted changes, empty branches and hosts without a pipeline backend', async () => {
  await createBranch(host, project, 'wip')
  await expect(delivery().merge({ project, branch: 'wip', summary: 'Nothing', agent })).rejects.toThrow('no changes')

  const { dir } = await workspaces.open(project, 'wip')
  writeFileSync(join(dir, 'src/wip.ts'), '')
  await expect(delivery().merge({ project, branch: 'wip', summary: 'Wip', agent })).rejects.toThrow('uncommitted changes')

  await expect(delivery(null).merge({ project, branch: 'wip', summary: 'Wip', agent })).rejects.toThrow(
    'no pipeline VM backend',
  )
  await expect(delivery().merge({ project, branch: DEFAULT_BRANCH, summary: 'x', agent })).rejects.toThrow()
})
