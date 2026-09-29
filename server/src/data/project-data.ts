import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  applyMigrations,
  appliedMigrations,
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  MigrationError,
  notStrictMessage,
  type Migration,
} from '../../../packages/sdk/src/db/migrations.ts'
import type { DbRequest, DbResponse } from '../../../packages/sdk/src/runner/protocol.ts'
import { repoPath, workspaceDir, type Host } from '../host.ts'
import { truncateMiddle } from '../mcp/output.ts'
import type { MigrationDryRun, StepOutcome } from '../pipeline/runner.ts'
import { appendLog, type LogLevel } from '../runtime/logs.ts'
import { createDbPool, DbTimeoutError, type DbPool } from './db-pool.ts'
import { DbFileError, removeDbFiles, takeDbFile } from './db-file.ts'
import type { RunMigrationVm } from './migration-vm.ts'
import {
  newTablesNotStrict,
  readMigrationsFromDir,
  readMigrationsFromGit,
  removedFromSchema,
  restrictMigrationDb,
  schemaOf,
  tableNames,
} from './migrations.ts'

export const DEFAULT_SLOW_QUERY_MS = 500
export const DEFAULT_SIZE_WARNING_BYTES = 100 * 1024 * 1024

const SIZE_CHECK_INTERVAL_MS = 60 * 1000
// The same slow statement is logged at most this often, so a hot path cannot flood the log.
const SLOW_LOG_INTERVAL_MS = 10 * 60 * 1000
const LOGGED_SQL_CHARS = 500
const MIGRATION_TIMEOUT_MS = 5 * 60 * 1000
// A migrated DB may grow to this many times the size it started at, and is never limited below the floor.
const MIGRATED_DB_GROWTH = 2
const MIGRATED_DB_MIN_LIMIT_BYTES = 512 * 1024 * 1024
const MIGRATION_DIR_SLACK_BYTES = 1024 * 1024

export type DbTarget = { project: string; branch?: string }

export type SlowQuery = { sql: string; durationMs: number; at: string }

export type DbStatus = {
  sizeBytes: number
  // Set once the DB is larger than the warning size.
  sizeWarning?: string
  slowQueries: { count: number; slowestMs: number; last?: SlowQuery }
}

export type ProjectDataOptions = {
  pool?: DbPool
  // Runs migrations in a VM. Without it they run on the host.
  runMigrationVm?: RunMigrationVm
  slowQueryMs?: number
  sizeWarningBytes?: number
}

type Stats = {
  slowCount: number
  slowestMs: number
  lastSlow?: SlowQuery
  slowLogged: Map<string, number>
  sizeCheckedAt: number
  sizeWarnedStep: number
}

function fileSize(path: string): number {
  let size = 0
  for (const file of [path, `${path}-wal`]) {
    try {
      size += statSync(file).size
    } catch {}
  }
  return size
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Owns the project DBs: `<dataDir>/projects/<project>/db.sqlite` for main, and
// a copy per branch workspace next to its checkout.
export function createProjectData(host: Host, options: ProjectDataOptions = {}) {
  const pool = options.pool ?? createDbPool()
  const slowQueryMs = options.slowQueryMs ?? DEFAULT_SLOW_QUERY_MS
  const sizeWarningBytes = options.sizeWarningBytes ?? DEFAULT_SIZE_WARNING_BYTES
  const stats = new Map<string, Stats>()
  const branchQueues = new Map<string, Promise<unknown>>()
  // Production queries wait here while a migrated copy of the DB replaces the file.
  const gates = new Map<string, Promise<void>>()
  // Migration fingerprint each branch DB was last brought up to, so most queries skip the check.
  const syncedBranches = new Map<string, string>()
  let runMigrationVm = options.runMigrationVm

  function dbPath(project: string): string {
    return join(host.dataDir, 'projects', project, 'db.sqlite')
  }

  function branchDbPath(project: string, branch: string): string {
    return join(workspaceDir(host, project, branch), 'db.sqlite')
  }

  function statsOf(project: string): Stats {
    let s = stats.get(project)
    if (!s) {
      s = { slowCount: 0, slowestMs: 0, slowLogged: new Map(), sizeCheckedAt: 0, sizeWarnedStep: 0 }
      stats.set(project, s)
    }
    return s
  }

  function log(project: string, level: LogLevel, message: string, invocationId?: number) {
    try {
      appendLog(host, { project, invocationId, source: 'runtime', level, event: 'db', message })
    } catch (err) {
      console.error(`Could not record a DB event for ${project}: ${message}`, err)
    }
  }

  function ownInvocation(project: string, invocation: unknown): number | undefined {
    if (typeof invocation !== 'number') return undefined
    const row = host.db
      .prepare('SELECT 1 FROM invocations i JOIN projects p ON p.id = i.project_id WHERE i.id = ? AND p.name = ?')
      .get(invocation, project)
    return row ? invocation : undefined
  }

  function recordSlow(target: DbTarget, sql: string, durationMs: number, invocation: number | undefined) {
    // Branch DBs are scratch copies; only production queries count for status.
    if (target.branch) return
    const s = statsOf(target.project)
    const at = new Date().toISOString()
    s.slowCount++
    s.slowestMs = Math.max(s.slowestMs, durationMs)
    s.lastSlow = { sql: truncateMiddle(sql, LOGGED_SQL_CHARS), durationMs: Math.round(durationMs), at }
    const loggedAt = s.slowLogged.get(sql)
    if (loggedAt !== undefined && Date.now() - loggedAt < SLOW_LOG_INTERVAL_MS) return
    s.slowLogged.set(sql, Date.now())
    log(
      target.project,
      'warn',
      `Slow query (${Math.round(durationMs)}ms, over ${slowQueryMs}ms): ${truncateMiddle(sql, LOGGED_SQL_CHARS)}. Add an index in a migration or narrow the query`,
      invocation,
    )
  }

  function checkSize(project: string, force = false) {
    const s = statsOf(project)
    if (!force && Date.now() - s.sizeCheckedAt < SIZE_CHECK_INTERVAL_MS) return
    s.sizeCheckedAt = Date.now()
    const step = Math.floor(fileSize(dbPath(project)) / sizeWarningBytes)
    if (step > s.sizeWarnedStep) {
      s.sizeWarnedStep = step
      log(project, 'warn', `The hob DB is ${formatBytes(fileSize(dbPath(project)))}, over ${formatBytes(step * sizeWarningBytes)}. Delete old rows or store less`)
    }
  }

  async function execute(target: DbTarget, request: DbRequest): Promise<DbResponse> {
    // Nothing between this wait and the pool call may be async: a query that
    // got past the gate has to be queued in the worker before a migration's
    // snapshot is.
    if (target.branch === undefined) {
      for (let gate = gates.get(target.project); gate; gate = gates.get(target.project)) await gate
    }
    const path = target.branch === undefined ? dbPath(target.project) : branchDbPath(target.project, target.branch)
    mkdirSync(dirname(path), { recursive: true })
    const invocation = ownInvocation(target.project, request?.invocation)
    let execution
    try {
      execution = await pool.execute(path, request)
    } catch (err) {
      if (!(err instanceof DbTimeoutError)) throw err
      const sql = request.statements?.map((s) => s.sql).join('; ') ?? ''
      recordSlow(target, sql, pool.timeoutMs, invocation)
      return { ok: false, error: { message: `${err.message}. Add an index in a migration or narrow the query`, code: 'timeout' } }
    }
    for (const timing of execution.timings) {
      if (timing.durationMs >= slowQueryMs) recordSlow(target, timing.sql, timing.durationMs, invocation)
    }
    if (target.branch === undefined) checkSize(target.project)
    return execution.response
  }

  function workRoot(): string {
    const dir = join(host.dataDir, 'migration-work')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  // Versions the DB at `path` has applied, with their checksums.
  async function appliedIn(path: string): Promise<Map<number, string>> {
    const applied = new Map<number, string>()
    if (!existsSync(path)) return applied
    const rows = async (sql: string, params?: string[]) => {
      const { response } = await pool.execute(path, { statements: [{ sql, params }], transaction: false })
      if (!response.ok) throw new Error(response.error.message)
      return response.results[0]?.rows ?? []
    }
    if (!(await rows("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [MIGRATIONS_TABLE])).length) return applied
    for (const row of await rows(`SELECT version, checksum FROM ${MIGRATIONS_TABLE}`)) {
      applied.set(Number(row.version), String(row.checksum))
    }
    return applied
  }

  // Holds back queries to a production DB while `fn` replaces its file, so no
  // write between the snapshot and the swap is lost.
  async function paused<T>(project: string, fn: () => Promise<T>): Promise<T> {
    for (let gate = gates.get(project); gate; gate = gates.get(project)) await gate
    let open = () => {}
    gates.set(
      project,
      new Promise<void>((resolve) => {
        open = resolve
      }),
    )
    try {
      return await fn()
    } finally {
      gates.delete(project)
      open()
    }
  }

  // A consistent snapshot of the DB at `path` in `work`, or nothing when it does not exist yet.
  async function snapshotOf(path: string, work: string): Promise<string | undefined> {
    if (!existsSync(path)) return undefined
    const snapshot = join(work, 'before.sqlite')
    await pool.copy(path, snapshot)
    return snapshot
  }

  function applyOnHost(path: string, migrations: Migration[], emptyCheck: boolean): { stage: 'empty' | 'copy'; error: string } | undefined {
    const run = (target: string, stage: 'empty' | 'copy') => {
      const db = new DatabaseSync(target)
      try {
        db.exec('PRAGMA foreign_keys = ON')
        restrictMigrationDb(db, migrations)
        applyMigrations(db, migrations)
      } catch (err) {
        if (err instanceof MigrationError) return { stage, error: err.message }
        throw err
      } finally {
        db.close()
      }
    }
    return (emptyCheck && run(':memory:', 'empty')) || run(path, 'copy')
  }

  // Applies `migrations` to `snapshot` (an empty DB when there is none), in a VM
  // when the host has one, and moves the DB that comes back into `work` once it
  // passes the checks in db-file.ts. The snapshot file is consumed.
  async function migrateCopy(
    project: string,
    work: string,
    snapshot: string | undefined,
    migrations: Migration[],
    emptyCheck: boolean,
  ): Promise<{ ok: true; db: string } | { ok: false; stage: 'empty' | 'copy'; error: string }> {
    const dir = join(work, 'vm')
    mkdirSync(dir)
    const input = join(dir, 'db.sqlite')
    const maxBytes = Math.max(MIGRATED_DB_MIN_LIMIT_BYTES, MIGRATED_DB_GROWTH * (snapshot ? statSync(snapshot).size : 0))
    if (snapshot) renameSync(snapshot, input)
    if (!runMigrationVm) {
      const failure = applyOnHost(input, migrations, emptyCheck)
      if (failure) return { ok: false, ...failure }
    } else {
      const inputJson = JSON.stringify({ files: migrations.map(({ name, sql }) => ({ name, sql })), emptyCheck })
      writeFileSync(join(dir, 'input.json'), inputJson)
      // The rollback journal or WAL can be as big as the DB again.
      const quotaBytes = 2 * maxBytes + Buffer.byteLength(inputJson) + MIGRATION_DIR_SLACK_BYTES
      const run = await runMigrationVm({ project, dir, timeoutMs: MIGRATION_TIMEOUT_MS, quotaBytes })
      if (run.timedOut) {
        return { ok: false, stage: 'copy', error: `The migrations did not finish within ${MIGRATION_TIMEOUT_MS / 60_000} minutes` }
      }
      let result: unknown
      try {
        result = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '')
      } catch {
        return { ok: false, stage: 'copy', error: `The migration VM failed with exit code ${run.exitCode}: ${truncateMiddle(run.stderr.trim(), 500)}` }
      }
      const outcome = (typeof result === 'object' && result !== null ? result : {}) as { ok?: unknown; stage?: unknown; error?: unknown }
      if (outcome.ok !== true) {
        const error = typeof outcome.error === 'string' ? truncateMiddle(outcome.error, 4000) : 'The migration VM gave no result'
        return { ok: false, stage: outcome.stage === 'empty' ? 'empty' : 'copy', error }
      }
    }
    const db = join(work, 'result.sqlite')
    try {
      takeDbFile(input, db, maxBytes)
    } catch (err) {
      if (err instanceof DbFileError) return { ok: false, stage: 'copy', error: err.message }
      throw err
    }
    return { ok: true, db }
  }

  // Replaces the DB at `path` with `fresh`, which must be on the same filesystem.
  async function replaceDb(path: string, fresh: string): Promise<void> {
    await pool.close(path)
    mkdirSync(dirname(path), { recursive: true })
    // A WAL left from the old file would be applied to the new one.
    for (const file of [`${path}-wal`, `${path}-shm`]) rmSync(file, { force: true })
    renameSync(fresh, path)
  }

  // The DB at `path` after `migrations`, migrated in a copy that replaces it.
  // Nothing else may write to it meanwhile.
  async function migrateInPlace(project: string, path: string, migrations: Migration[]): Promise<void> {
    const work = mkdtempSync(join(workRoot(), 'migrate-'))
    try {
      const result = await migrateCopy(project, work, await snapshotOf(path, work), migrations, false)
      if (!result.ok) throw new MigrationError(result.error)
      await replaceDb(path, result.db)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  // Applies the migrations of a version on main to the production DB, before
  // the version starts. Changed migrations were refused by the dry run; a
  // restore of an older version simply has fewer migrations. A failing
  // migration leaves the DB as it was.
  async function migrate(project: string, commit: string): Promise<Migration[]> {
    const migrations = await readMigrationsFromGit(repoPath(host, project), commit)
    if (!migrations.length) return []
    const path = dbPath(project)
    try {
      const done = await appliedIn(path)
      const pending = migrations.filter((m) => !done.has(m.version))
      if (!pending.length) return []
      await paused(project, () => migrateInPlace(project, path, migrations))
      log(project, 'info', `Applied migrations: ${pending.map((m) => m.name).join(', ')}`)
      return pending
    } catch (err) {
      log(project, 'error', `Migration failed: ${(err as Error).message}`)
      throw err
    } finally {
      checkSize(project, true)
    }
  }

  // Applies the candidate's new migrations to a copy of the production DB, and
  // all of them to an empty DB, which is what tests and new branches start from.
  // The schema checks read the DB that comes back, not what the runner says.
  async function dryRun(candidate: { project: string; gitDir: string; commit: string }): Promise<StepOutcome> {
    let migrations: Migration[]
    try {
      migrations = await readMigrationsFromGit(candidate.gitDir, candidate.commit)
    } catch (err) {
      if (err instanceof MigrationError) return { status: 'failed', output: err.message }
      throw err
    }
    if (!migrations.length) return { status: 'skipped', output: `No migrations in ${MIGRATIONS_DIR}/` }

    const work = mkdtempSync(join(workRoot(), 'dry-run-'))
    try {
      const snapshot = await snapshotOf(dbPath(candidate.project), work)
      let done = new Map<number, { checksum: string }>()
      let before = schemaOf(new DatabaseSync(':memory:'))
      let beforeTables = new Set<string>()
      if (snapshot) {
        const db = new DatabaseSync(snapshot)
        try {
          done = appliedMigrations(db)
          before = schemaOf(db)
          beforeTables = tableNames(db)
        } finally {
          db.close()
        }
      }
      const started = performance.now()
      let result
      try {
        result = await migrateCopy(candidate.project, work, snapshot, migrations, true)
      } catch (err) {
        return { status: 'failed', output: `The migrations could not run: ${(err as Error).message}` }
      }
      if (!result.ok) {
        return { status: 'failed', output: `${result.stage === 'empty' ? 'On an empty DB' : 'On a copy of the production DB'}: ${result.error}` }
      }
      const elapsed = Math.round(performance.now() - started)
      const after = new DatabaseSync(result.db)
      let problems: string[]
      try {
        after.exec('PRAGMA trusted_schema = OFF')
        const notStrict = newTablesNotStrict(after, beforeTables)
        problems = [
          ...migrations
            .filter((m) => done.has(m.version) && done.get(m.version)?.checksum !== m.checksum)
            .map(
              (m) =>
                `${MIGRATIONS_DIR}/${m.name} changed after it was applied to the production DB. Applied migrations cannot change: undo the edit and add a new migration`,
            ),
          ...removedFromSchema(before, schemaOf(after)).map(
            (problem) => `${problem}. Migrations must only add tables and columns, so older versions keep working after a restore`,
          ),
          ...(notStrict.length ? [notStrictMessage(notStrict)] : []),
        ]
      } finally {
        after.close()
      }
      if (problems.length) return { status: 'failed', output: problems.join('\n') }
      const output = [`All ${migrations.length} migrations apply to an empty DB`]
      const applied = migrations.filter((m) => !done.has(m.version))
      output.push(
        applied.length
          ? `Applied ${applied.map((m) => m.name).join(', ')} to a copy of the production DB in ${elapsed}ms`
          : `No new migrations for the production DB (${done.size} applied)`,
      )
      return { status: 'passed', output: output.join('\n') }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  // Serializes work on one branch DB, since recreating it closes its worker.
  function onBranch<T>(project: string, branch: string, fn: () => Promise<T>): Promise<T> {
    const key = `${project}\0${branch}`
    const run = (branchQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    branchQueues.set(key, run)
    void run
      .catch(() => {})
      .finally(() => {
        if (branchQueues.get(key) === run) branchQueues.delete(key)
      })
    return run
  }

  async function copyProduction(project: string, branch: string): Promise<void> {
    const path = branchDbPath(project, branch)
    syncedBranches.delete(path)
    await pool.close(path)
    removeDbFiles(path)
    mkdirSync(dirname(path), { recursive: true })
    const production = dbPath(project)
    if (existsSync(production)) await pool.copy(production, path)
  }

  // Applies the branch's migrations that its DB has not seen. When a migration
  // it already applied was edited (normal while developing), the DB starts over
  // from a fresh copy of production.
  async function syncBranch(project: string, branch: string, migrations: Migration[]): Promise<void> {
    const path = branchDbPath(project, branch)
    if (!existsSync(path)) await copyProduction(project, branch)
    if (!migrations.length) return
    const fingerprint = migrations.map((m) => `${m.version}:${m.checksum}`).join(',')
    if (syncedBranches.get(path) === fingerprint) return
    let done = await appliedIn(path)
    if (migrations.some((m) => done.has(m.version) && done.get(m.version) !== m.checksum)) {
      await copyProduction(project, branch)
      done = await appliedIn(path)
    }
    if (migrations.some((m) => !done.has(m.version))) await migrateInPlace(project, path, migrations)
    syncedBranches.set(path, fingerprint)
  }

  return {
    dbPath,
    branchDbPath,
    execute,
    migrate,
    dryRun,
    migrationDryRun: ((candidate) => dryRun(candidate)) satisfies MigrationDryRun,

    // A copy of the production DB for a workspace VM that is starting.
    resetBranch(project: string, branch: string): Promise<void> {
      return onBranch(project, branch, () => copyProduction(project, branch))
    },

    // Runs a query on the branch DB after applying the branch's pending
    // migrations: those in the workspace checkout at `source`, or those of a
    // commit for a branch preview.
    executeOnBranch(
      project: string,
      branch: string,
      source: string | (() => Promise<Migration[]>),
      request: DbRequest,
    ): Promise<DbResponse> {
      return onBranch(project, branch, async () => {
        try {
          await syncBranch(project, branch, typeof source === 'string' ? readMigrationsFromDir(source) : await source())
        } catch (err) {
          return { ok: false, error: { message: `The branch DB could not be migrated: ${(err as Error).message}`, code: 'migration' } }
        }
        return execute({ project, branch }, request)
      })
    },

    // Sets how migrations run once the guest image is known.
    useMigrationVm(run: RunMigrationVm | undefined) {
      runMigrationVm = run
    },

    async closeBranch(project: string, branch: string): Promise<void> {
      syncedBranches.delete(branchDbPath(project, branch))
      await pool.close(branchDbPath(project, branch))
    },

    // Closes the production DB and forgets its warnings, before it is moved away.
    async closeProject(project: string): Promise<void> {
      await pool.close(dbPath(project))
      stats.delete(project)
    },

    status(project: string): DbStatus {
      const s = statsOf(project)
      checkSize(project)
      const sizeBytes = fileSize(dbPath(project))
      return {
        sizeBytes,
        ...(sizeBytes >= sizeWarningBytes
          ? { sizeWarning: `The hob DB is ${formatBytes(sizeBytes)}, over the ${formatBytes(sizeWarningBytes)} warning size` }
          : {}),
        slowQueries: {
          count: s.slowCount,
          slowestMs: Math.round(s.slowestMs),
          ...(s.lastSlow ? { last: s.lastSlow } : {}),
        },
      }
    },

    stop: () => pool.closeAll(),
  }
}

export type ProjectData = ReturnType<typeof createProjectData>
