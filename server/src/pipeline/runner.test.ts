import { afterEach, beforeEach, expect, test } from 'vitest'
import { git } from '../git.ts'
import { repoPath } from '../host.ts'
import { createProject, DEFAULT_BRANCH } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { FAKE_PROJECT, fakePackageJson, seedMain } from '../test-project.ts'
import type { ExecResult, ExecWorkspaceVm } from '../workspaces.ts'
import { extraDependencies, platformPackages } from './platform.ts'
import { failInterruptedRuns, getRun, latestRun, runPipeline, type PipelineOptions } from './runner.ts'

let host: ReturnType<typeof createTestHost>
let commands: string[]
let stops: number

function recordingVm(respond: (command: string) => Promise<ExecResult> | ExecResult): PipelineOptions['startVm'] {
  return async () => {
    const vm: ExecWorkspaceVm = {
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

const passing = recordingVm((command) => ({ exitCode: 0, stdout: `ran ${command}\n`, stderr: '' }))

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

test('installs only when the project has dependencies outside the platform set', async () => {
  const pkg = JSON.parse(fakePackageJson())
  const withExtras = { ...FAKE_PROJECT, 'package.json': JSON.stringify({ ...pkg, dependencies: { react: '^19', 'left-pad': '1' } }) }
  const run = await runPipeline(host, { startVm: passing }, { project: 'filament', ...(await seed(withExtras)) })
  expect(run.steps.find((s) => s.name === 'install')?.status).toBe('passed')
  expect(commands[0]).toBe('pnpm install')

  expect(platformPackages().has('react')).toBe(true)
  expect(extraDependencies({ dependencies: { react: '^19' }, devDependencies: { vitest: '^4', 'left-pad': '1' } })).toEqual([
    'left-pad',
  ])
})

test('uses the migration dry run hook', async () => {
  const run = await runPipeline(
    host,
    { startVm: passing, migrationDryRun: async ({ dir }) => ({ status: 'failed', output: `bad migration in ${dir !== ''}` }) },
    { project: 'filament', ...(await seed()) },
  )
  expect(run).toMatchObject({ status: 'failed', failedStep: 'migrations' })
  expect(run.steps.at(-1)?.output).toBe('bad migration in true')
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
