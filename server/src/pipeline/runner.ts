import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, GitError } from '../git.ts'
import type { Host } from '../host.ts'
import { truncateMiddle } from '../mcp/output.ts'
import { requireProject } from '../projects.ts'
import { saveBuild } from '../runtime/builds.ts'
import { appendLog } from '../runtime/logs.ts'
import type { ExecWorkspaceVm } from '../workspaces.ts'
import { extraDependencies } from '../platform.ts'
import { validateHobworkJson } from './validate.ts'

// `iconsCommand` renders the project icon into dist/ after the build, given
// the project name as its last argument. VMs without it leave icons out.
export type PipelineVm = ExecWorkspaceVm & { iconsCommand?: string }

// Seam for the sandbox layer: start a fresh VM with `dir` (a clean checkout of
// the candidate) mounted read-write. Exec `cwd` is relative to `dir`. The VM is
// stopped when the run ends and never reused.
export type StartPipelineVm = (options: { dir: string }) => Promise<PipelineVm>

export type StepOutcome = { status: 'passed' | 'failed' | 'skipped'; output: string }

// Applies the candidate's new migrations to a copy of the production DB.
// `gitDir` contains `commit`. Files are read from there, not from the checkout.
export type MigrationDryRun = (candidate: { project: string; gitDir: string; commit: string }) => Promise<StepOutcome>

export type PipelineOptions = {
  startVm: StartPipelineVm
  stepTimeoutMs?: number
  migrationDryRun?: MigrationDryRun
}

export const PIPELINE_STEPS = ['validate', 'install', 'typecheck', 'lint', 'test', 'build', 'migrations'] as const
export type PipelineStepName = (typeof PIPELINE_STEPS)[number]

export type StepStatus = 'pending' | 'running' | StepOutcome['status']
export type RunStatus = 'running' | 'passed' | 'failed'

export type PipelineStep = {
  name: PipelineStepName
  status: StepStatus
  output: string
  durationMs: number | null
}

export type PipelineRun = {
  id: number
  project: string
  branch: string | null
  commit: string
  agent: string | null
  status: RunStatus
  failedStep: PipelineStepName | null
  startedAt: string
  finishedAt: string | null
  steps: PipelineStep[]
}

export type Candidate = {
  project: string
  // Git directory that contains `commit`. Candidates built for a merge live in
  // a temporary clone until they pass.
  gitDir: string
  commit: string
  branch?: string
  agentId?: number
}

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000
// Full step output stays in pipeline_status. The log store gets enough to see what happened.
const PIPELINE_LOG_CHARS = 2_000

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

const skipMigrations: MigrationDryRun = async () => ({
  status: 'skipped',
  output: 'This host has no migration dry run',
})

// Read from git rather than the checkout so a symlinked file cannot make the
// host read something outside the candidate.
export async function readBlob(gitDir: string, commit: string, path: string): Promise<string | undefined> {
  try {
    return await git(['--git-dir', gitDir, 'show', `${commit}:${path}`])
  } catch (err) {
    if (err instanceof GitError) return undefined
    throw err
  }
}

export async function checkout(gitDir: string, commit: string, tmp: string): Promise<string> {
  const dir = join(tmp, 'files')
  mkdirSync(dir)
  const env = { GIT_INDEX_FILE: join(tmp, 'index') }
  await git(['--git-dir', gitDir, '--work-tree', dir, 'read-tree', commit], { env })
  await git(['--git-dir', gitDir, '--work-tree', dir, 'checkout-index', '--all', '--force'], { env })
  return dir
}

async function exec(vm: PipelineVm, command: string, timeoutMs: number): Promise<StepOutcome> {
  const timeout = AbortSignal.timeout(timeoutMs)
  let streamed = ''
  const timedOut = new Promise<'timeout'>((resolve) => {
    timeout.addEventListener('abort', () => resolve('timeout'), { once: true })
  })
  const result = await Promise.race([
    vm.exec(command, {
      cwd: '.',
      timeoutMs,
      signal: timeout,
      onOutput: (_, chunk) => {
        streamed += chunk
      },
    }),
    timedOut,
  ])
  const header = `$ ${command}\n`
  if (result === 'timeout') {
    return { status: 'failed', output: `${header}${streamed}\nTimed out after ${timeoutMs / 1000}s` }
  }
  const output = streamed || result.stdout + result.stderr
  if (result.exitCode !== 0) {
    return { status: 'failed', output: `${header}${output}\nexit code: ${result.exitCode}` }
  }
  return { status: 'passed', output: header + output }
}

export async function runPipeline(host: Host, options: PipelineOptions, candidate: Candidate): Promise<PipelineRun> {
  const { id: projectId } = requireProject(host, candidate.project)
  const timeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const migrationDryRun = options.migrationDryRun ?? skipMigrations
  const { gitDir, commit } = candidate

  const run = host.db
    .prepare('INSERT INTO pipeline_runs (project_id, branch, commit_sha, agent_id) VALUES (?, ?, ?, ?) RETURNING id')
    .get(projectId, candidate.branch ?? null, commit, candidate.agentId ?? null)
  if (!run) throw new Error('Pipeline run insert returned no row')
  const runId = Number(run.id)
  const insertStep = host.db.prepare('INSERT INTO pipeline_steps (run_id, position, name) VALUES (?, ?, ?)')
  PIPELINE_STEPS.forEach((name, position) => insertStep.run(runId, position, name))
  const updateStep = host.db.prepare(
    'UPDATE pipeline_steps SET status = ?, output = ?, duration_ms = ? WHERE run_id = ? AND name = ?',
  )

  function logStep(id: number, name: PipelineStepName, outcome: StepOutcome, durationMs: number) {
    const where = candidate.branch ? ` (${candidate.branch})` : ''
    appendLog(host, {
      project: candidate.project,
      source: 'pipeline',
      event: 'pipeline',
      level: outcome.status === 'failed' ? 'error' : 'info',
      message: `Pipeline run ${id}${where}: ${name} ${outcome.status} in ${(durationMs / 1000).toFixed(1)}s${
        outcome.output ? `\n${truncateMiddle(outcome.output, PIPELINE_LOG_CHARS)}` : ''
      }`,
    })
  }

  const tmp = mkdtempSync(join(tmpdir(), 'hobwork-pipeline-'))
  let vm: PipelineVm | undefined
  let checkedOut: Promise<string> | undefined
  const dir = () => (checkedOut ??= checkout(gitDir, commit, tmp))
  async function inVm(command: string): Promise<StepOutcome> {
    vm ??= await options.startVm({ dir: await dir() })
    return exec(vm, command, timeoutMs)
  }

  const steps: Record<PipelineStepName, () => Promise<StepOutcome>> = {
    async validate() {
      const problems = validateHobworkJson(await readBlob(gitDir, commit, 'hobwork.json'))
      if (problems.length) return { status: 'failed', output: `hobwork.json is invalid:\n${problems.join('\n')}` }
      return { status: 'passed', output: 'hobwork.json is valid' }
    },
    async install() {
      const raw = await readBlob(gitDir, commit, 'package.json')
      if (raw === undefined) return { status: 'failed', output: 'package.json is missing' }
      let extras: string[]
      try {
        extras = extraDependencies(JSON.parse(raw))
      } catch (err) {
        return { status: 'failed', output: `package.json is not valid JSON: ${(err as Error).message}` }
      }
      if (!extras.length) return { status: 'skipped', output: 'No extra dependencies. Platform packages come with the VM.' }
      return inVm('pnpm install')
    },
    typecheck: () => inVm('pnpm run typecheck'),
    lint: () => inVm('pnpm run lint'),
    test: () => inVm('pnpm run test'),
    async build() {
      let outcome = await inVm('pnpm run build')
      if (outcome.status === 'passed' && vm?.iconsCommand) {
        const icons = await inVm(`${vm.iconsCommand} ${candidate.project}`)
        outcome = { status: icons.status, output: `${outcome.output}\n${icons.output}` }
      }
      // The checkout is deleted after the run, so the build is kept for deploy.
      if (outcome.status === 'passed') await saveBuild(host, { project: candidate.project, gitDir, commit, dir: await dir() })
      return outcome
    },
    migrations: () => migrationDryRun({ project: candidate.project, gitDir, commit }),
  }

  let failedStep: PipelineStepName | undefined
  try {
    for (const name of PIPELINE_STEPS) {
      if (failedStep) {
        updateStep.run('skipped', '', null, runId, name)
        continue
      }
      updateStep.run('running', '', null, runId, name)
      const started = performance.now()
      let outcome: StepOutcome
      try {
        outcome = await steps[name]()
      } catch (err) {
        outcome = { status: 'failed', output: `Step could not run: ${(err as Error).message}` }
      }
      const durationMs = Math.round(performance.now() - started)
      updateStep.run(outcome.status, truncateMiddle(outcome.output), durationMs, runId, name)
      logStep(runId, name, outcome, durationMs)
      if (outcome.status === 'failed') failedStep = name
    }
  } finally {
    await vm?.stop().catch((err: unknown) => console.error('Stopping pipeline VM failed', err))
    rmSync(tmp, { recursive: true, force: true })
  }

  host.db
    .prepare(`UPDATE pipeline_runs SET status = ?, failed_step = ?, finished_at = ${NOW} WHERE id = ?`)
    .run(failedStep ? 'failed' : 'passed', failedStep ?? null, runId)
  const finished = getRun(host, runId)
  if (!finished) throw new Error(`Pipeline run ${runId} missing after it finished`)
  return finished
}

const SELECT_RUN = `SELECT r.id, p.name AS project, r.branch, r.commit_sha, a.name AS agent, r.status,
    r.failed_step, r.started_at, r.finished_at
  FROM pipeline_runs r JOIN projects p ON p.id = r.project_id LEFT JOIN agents a ON a.id = r.agent_id`

function toRun(host: Host, row: Record<string, unknown>): PipelineRun {
  const id = Number(row.id)
  const steps = host.db
    .prepare('SELECT name, status, output, duration_ms FROM pipeline_steps WHERE run_id = ? ORDER BY position')
    .all(id)
    .map((step) => ({
      name: String(step.name) as PipelineStepName,
      status: String(step.status) as StepStatus,
      output: String(step.output),
      durationMs: step.duration_ms === null ? null : Number(step.duration_ms),
    }))
  return {
    id,
    project: String(row.project),
    branch: row.branch === null ? null : String(row.branch),
    commit: String(row.commit_sha),
    agent: row.agent === null ? null : String(row.agent),
    status: String(row.status) as RunStatus,
    failedStep: row.failed_step === null ? null : (String(row.failed_step) as PipelineStepName),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    steps,
  }
}

export function getRun(host: Host, id: number): PipelineRun | undefined {
  const row = host.db.prepare(`${SELECT_RUN} WHERE r.id = ?`).get(id)
  return row ? toRun(host, row) : undefined
}

export function latestRun(host: Host, project: string, branch?: string): PipelineRun | undefined {
  const row =
    branch === undefined
      ? host.db.prepare(`${SELECT_RUN} WHERE p.name = ? ORDER BY r.id DESC LIMIT 1`).get(project)
      : host.db.prepare(`${SELECT_RUN} WHERE p.name = ? AND r.branch = ? ORDER BY r.id DESC LIMIT 1`).get(project, branch)
  return row ? toRun(host, row) : undefined
}

// Runs do not survive a host restart.
export function failInterruptedRuns(host: Host): void {
  host.db.exec(`
    UPDATE pipeline_steps SET status = 'failed', output = 'Interrupted by a host restart'
      WHERE status = 'running';
    UPDATE pipeline_steps SET status = 'skipped'
      WHERE status = 'pending' AND run_id IN (SELECT id FROM pipeline_runs WHERE status = 'running');
    UPDATE pipeline_runs SET status = 'failed', finished_at = ${NOW},
      failed_step = (SELECT name FROM pipeline_steps s WHERE s.run_id = pipeline_runs.id AND s.status = 'failed')
      WHERE status = 'running';
  `)
}
