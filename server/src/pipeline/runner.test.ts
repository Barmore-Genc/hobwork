import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { git } from '../git.ts'
import { repoPath } from '../host.ts'
import { buildDir, projectBuildsDir } from '../runtime/builds.ts'
import { createProject, DEFAULT_BRANCH } from '../projects.ts'
import { queryLogs } from '../runtime/logs.ts'
import { createTestHost } from '../test-host.ts'
import { FAKE_PROJECT, fakePackageJson, seedMain } from '../test-project.ts'
import type { ExecResult } from '../workspaces.ts'
import { extraDependencies, platformPackages } from '../platform.ts'
import { failInterruptedRuns, getRun, latestRun, runPipeline, type PipelineOptions, type PipelineVm } from './runner.ts'

let host: ReturnType<typeof createTestHost>
let commands: string[]
let stops: number

function recordingVm(
  respond: (command: string) => Promise<ExecResult> | ExecResult,
  iconsCommand?: string,
): PipelineOptions['startVm'] {
  return async () => {
    const vm: PipelineVm = {
      iconsCommand,
      async stop() {
        stops++
      },
      async exec(command, { onOutput }) {
        commands.push(command)
        const result = await respond(command)
        onOutput?.('stdout', result.stdout)
        return result
      },
    }
    return vm
  }
}

const pass = (command: string): ExecResult => ({ exitCode: 0, stdout: `ran ${command}\n`, stderr: '' })
const passing = recordingVm(pass)

async function seed(files = FAKE_PROJECT): Promise<{ gitDir: string; commit: string }> {
  await seedMain(host, 'filament', files)
  const gitDir = repoPath(host, 'filament')
  return { gitDir, commit: (await git(['--git-dir', gitDir, 'rev-parse', DEFAULT_BRANCH])).trim() }
}

beforeEach(async () => {
  host = createTestHost()
  commands = []
  stops = 0
  await createProject(host, 'filament')
})

afterEach(() => host.dispose())

test('runs the package.json scripts in one VM and records every step', async () => {
  const run = await runPipeline(host, { startVm: passing }, { project: 'filament', ...(await seed()) })
  expect(commands).toEqual(['pnpm run typecheck', 'pnpm run lint', 'pnpm run test', 'pnpm run build'])
  expect(stops).toBe(1)
  expect(run.status).toBe('passed')
  expect(run.steps.find((s) => s.name === 'lint')?.output).toBe('$ pnpm run lint\nran pnpm run lint\n')
  expect(run.steps.every((s) => s.durationMs !== null)).toBe(true)
  expect(getRun(host, run.id)).toEqual(run)
  expect(latestRun(host, 'filament')?.id).toBe(run.id)
})

test('renders the project icon after the build, and a wrong icon fails the build', async () => {
  const candidate = { project: 'filament', ...(await seed()) }
  const run = await runPipeline(host, { startVm: recordingVm(pass, 'render-icons') }, candidate)
  expect(commands.slice(-2)).toEqual(['pnpm run build', 'render-icons filament'])
  expect(run.steps.find((s) => s.name === 'build')?.output).toContain('ran render-icons filament')

  const wrongIcon = recordingVm(
    (command) =>
      command.startsWith('render-icons')
        ? { exitCode: 1, stdout: 'hobwork.json: "icon" is "x.png", which is not a file in the hob\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    'render-icons',
  )
  const failed = await runPipeline(host, { startVm: wrongIcon }, candidate)
  expect(failed.failedStep).toBe('build')
  expect(failed.steps.find((s) => s.name === 'build')?.output).toContain('not a file in the hob')
})

test('installs only when the project has dependencies outside the platform set', async () => {
  const pkg = JSON.parse(fakePackageJson())
  const withExtras = {
    ...FAKE_PROJECT,
    'package.json': JSON.stringify({ ...pkg, dependencies: { react: '^19', 'left-pad': '1' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  }
  const run = await runPipeline(host, { startVm: passing }, { project: 'filament', ...(await seed(withExtras)) })
  expect(run.steps.find((s) => s.name === 'install')?.status).toBe('passed')
  expect(commands[0]).toBe('pnpm install --frozen-lockfile --ignore-pnpmfile')

  expect(platformPackages().has('react')).toBe(true)
  expect(platformPackages().has('@hobwork/sdk')).toBe(true)
  expect(extraDependencies({ dependencies: { react: '^19' }, devDependencies: { vitest: '^4', 'left-pad': '1' } })).toEqual([
    'left-pad',
  ])
})

test('uses the migration dry run hook', async () => {
  const run = await runPipeline(
    host,
    { startVm: passing, migrationDryRun: async ({ commit }) => ({ status: 'failed', output: `bad migration in ${commit.length}` }) },
    { project: 'filament', ...(await seed()) },
  )
  expect(run).toMatchObject({ status: 'failed', failedStep: 'migrations' })
  expect(run.steps.at(-1)?.output).toBe('bad migration in 40')
})

test('fails a step that times out or whose VM cannot start', async () => {
  const candidate = { project: 'filament', ...(await seed()) }
  const hanging = recordingVm(() => new Promise<ExecResult>(() => {}))
  const timedOut = await runPipeline(host, { startVm: hanging, stepTimeoutMs: 50 }, candidate)
  expect(timedOut.failedStep).toBe('typecheck')
  expect(timedOut.steps.find((s) => s.name === 'typecheck')?.output).toContain('Timed out')
  expect(stops).toBe(1)

  const broken = await runPipeline(
    host,
    { startVm: async () => Promise.reject(new Error('no KVM')) },
    candidate,
  )
  expect(broken.failedStep).toBe('typecheck')
  expect(broken.steps.find((s) => s.name === 'typecheck')?.output).toContain('no KVM')
})

test('keeps only the head and tail of a step that prints endlessly', async () => {
  const noisy = recordingVm(() => ({ exitCode: 0, stdout: '', stderr: '' }))
  const streaming: PipelineOptions['startVm'] = async (options) => {
    const vm = await noisy(options)
    return {
      ...vm,
      async exec(command, execOptions) {
        for (let i = 0; i < 500; i++) execOptions.onOutput?.('stdout', `line ${i} ${'x'.repeat(1000)}\n`)
        execOptions.onOutput?.('stdout', 'last line\n')
        return vm.exec(command, execOptions)
      },
    }
  }
  const run = await runPipeline(host, { startVm: streaming }, { project: 'filament', ...(await seed()) })
  const output = run.steps.find((s) => s.name === 'typecheck')?.output ?? ''
  expect(output.length).toBeLessThan(31_000)
  expect(output.startsWith('$ pnpm run typecheck\nline 0 ')).toBe(true)
  expect(output).toContain('characters omitted')
  expect(output.endsWith('last line\n')).toBe(true)
})

test('marks runs interrupted by a restart as failed', async () => {
  const { gitDir, commit } = await seed()
  const { promise: gate, resolve: release } = Promise.withResolvers<void>()
  const blocked = recordingVm(async () => {
    await gate
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  const pending = runPipeline(host, { startVm: blocked }, { project: 'filament', gitDir, commit })
  await expect.poll(() => commands.length).toBe(1)

  failInterruptedRuns(host)
  const run = latestRun(host, 'filament')
  expect(run).toMatchObject({ status: 'failed', failedStep: 'typecheck' })
  expect(run?.steps.find((s) => s.name === 'typecheck')?.output).toContain('host restart')
  expect(run?.steps.find((s) => s.name === 'build')?.status).toBe('skipped')
  release()
  await pending
})

const EXTRAS = JSON.stringify({ ...JSON.parse(fakePackageJson()), dependencies: { 'left-pad': '1' } })

test('fails the install of extras without a lockfile and tells the agent what to do', async () => {
  const run = await runPipeline(
    host,
    { startVm: passing },
    { project: 'filament', ...(await seed({ ...FAKE_PROJECT, 'package.json': EXTRAS })) },
  )
  expect(run.failedStep).toBe('install')
  expect(run.steps.find((s) => s.name === 'install')?.output).toContain(
    'Run pnpm install in the workspace, then commit pnpm-lock.yaml',
  )
  expect(commands).toEqual([])
})

test('explains an outdated lockfile', async () => {
  const outdated = recordingVm((command) =>
    command.startsWith('pnpm install')
      ? { exitCode: 1, stdout: ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\n', stderr: '' }
      : pass(command),
  )
  const run = await runPipeline(
    host,
    { startVm: outdated },
    { project: 'filament', ...(await seed({ ...FAKE_PROJECT, 'package.json': EXTRAS, 'pnpm-lock.yaml': 'x: 1\n' })) },
  )
  expect(run.failedStep).toBe('install')
  expect(run.steps.find((s) => s.name === 'install')?.output).toContain('then commit pnpm-lock.yaml')
})

test('refuses a hob whose pnpm-workspace.yaml weakens the install protections', async () => {
  for (const setting of ['minimumReleaseAge: 0', 'dangerouslyAllowAllBuilds: true']) {
    const run = await runPipeline(
      host,
      { startVm: passing },
      { project: 'filament', ...(await seed({ ...FAKE_PROJECT, 'pnpm-workspace.yaml': `${setting}\n` })) },
    )
    expect(run.failedStep).toBe('validate')
    expect(run.steps.find((s) => s.name === 'validate')?.output).toContain(setting.split(':')[0])
  }
  expect(commands).toEqual([])
})

test('shows changes to the packages allowed to run install scripts in the validate step', async () => {
  const workspace = (builds: string[]) => ({
    ...FAKE_PROJECT,
    'pnpm-workspace.yaml': `allowBuilds:\n${builds.map((name) => `  ${name}: true\n`).join('')}`,
  })
  await seed(workspace(['esbuild']))
  const { gitDir, commit } = await seed(workspace(['esbuild', 'sharp']))
  const changed = await runPipeline(host, { startVm: passing }, { project: 'filament', gitDir, commit })
  expect(changed.steps.find((s) => s.name === 'validate')?.output).toContain('now allowed: sharp')

  const same = await seed({ ...workspace(['esbuild', 'sharp']), 'src/b.ts': 'export const b = 2\n' })
  const unchanged = await runPipeline(host, { startVm: passing }, { project: 'filament', ...same })
  expect(unchanged.steps.find((s) => s.name === 'validate')?.output).toBe('hobwork.json is valid')
})

// The VM writes into dist/ as it stops, which only ends up in the build if the copy runs afterwards.
test('copies the build only after the VM has stopped', async () => {
  const startVm: PipelineOptions['startVm'] = async ({ dir }) => ({
    async stop() {
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist/written-while-stopping.txt'), 'late')
    },
    async exec(command, { onOutput }) {
      onOutput?.('stdout', command)
      return { exitCode: 0, stdout: command, stderr: '' }
    },
  })
  const run = await runPipeline(host, { startVm }, { project: 'filament', ...(await seed()) })
  expect(run.status).toBe('passed')
  const [tree] = readdirSync(projectBuildsDir(host, 'filament')).filter((name) => !name.startsWith('.'))
  expect(existsSync(join(buildDir(host, 'filament', tree ?? ''), 'written-while-stopping.txt'))).toBe(true)
})

test('streams step output to the log store line by line', async () => {
  const startVm = recordingVm((command) => ({ exitCode: 0, stdout: `first ${command}\nsecond\n`, stderr: '' }))
  await runPipeline(host, { startVm }, { project: 'filament', ...(await seed()) })
  const lines = queryLogs(host, { project: 'filament', source: 'pipeline', limit: 100 }).map((entry) => entry.message)
  expect(lines).toContain('run 1 lint: $ pnpm run lint')
  expect(lines).toContain('run 1 lint: first pnpm run lint')
  expect(lines).toContain('run 1 lint: second')
  expect(lines.some((line) => line.startsWith('Pipeline run 1: lint passed in'))).toBe(true)
})
