import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  applyMigrations,
  appliedMigrations,
  MIGRATIONS_DIR,
  MigrationError,
  notStrictMessage,
  type Migration,
} from '../../../packages/sdk/src/db/migrations.ts'
import type { DbRequest, DbResponse } from '../../../packages/sdk/src/runner/protocol.ts'
import { openDb } from '../db.ts'
import { repoPath, workspaceDir, type Host } from '../host.ts'
import { truncateMiddle } from '../mcp/output.ts'
import type { MigrationDryRun, StepOutcome } from '../pipeline/runner.ts'
import { appendLog, type LogLevel } from '../runtime/logs.ts'
import { createDbPool, DbTimeoutError, type DbPool } from './db-pool.ts'
import { readMigrationsFromDir, readMigrationsFromGit, removedFromSchema, schemaOf } from './migrations.ts'

export const DEFAULT_SLOW_QUERY_MS = 500
export const DEFAULT_SIZE_WARNING_BYTES = 100 * 1024 * 1024

const SIZE_CHECK_INTERVAL_MS = 60 * 1000
// The same slow statement is logged at most this often, so a hot path cannot flood the log.
const SLOW_LOG_INTERVAL_MS = 10 * 60 * 1000
const LOGGED_SQL_CHARS = 500

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

function removeDbFiles(path: string) {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true })
}

function openProjectDb(path: string): DatabaseSync {
  const db = openDb(path)
  db.enableDefensive(true)
  return db
}

// Owns the project DBs: `<dataDir>/projects/<project>/db.sqlite` for main, and
// a copy per branch workspace next to its checkout.
export function createProjectData(host: Host, options: ProjectDataOptions = {}) {
  const pool = options.pool ?? createDbPool()
  const slowQueryMs = options.slowQueryMs ?? DEFAULT_SLOW_QUERY_MS
  const sizeWarningBytes = options.sizeWarningBytes ?? DEFAULT_SIZE_WARNING_BYTES
  const stats = new Map<string, Stats>()
  const branchQueues = new Map<string, Promise<unknown>>()

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

  // Applies the migrations of a version on main to the production DB, before
  // the version starts. Changed migrations were refused by the dry run; a
  // restore of an older version simply has fewer migrations.
  async function migrate(project: string, commit: string): Promise<Migration[]> {
    const migrations = await readMigrationsFromGit(repoPath(host, project), commit)
    if (!migrations.length) return []
    const db = openProjectDb(dbPath(project))
    try {
      const outcome = applyMigrations(db, migrations)
      if (outcome.applied.length) {
        log(project, 'info', `Applied migrations: ${outcome.applied.map((m) => m.name).join(', ')}`)
      }
      return outcome.applied
    } catch (err) {
      log(project, 'error', `Migration failed: ${(err as Error).message}`)
      throw err
    } finally {
      db.close()
      checkSize(project, true)
    }
  }

  // Applies the candidate's new migrations to a copy of the production DB, and
  // all of them to an empty DB, which is what tests and new branches start from.
  async function dryRun(candidate: { project: string; gitDir: string; commit: string }): Promise<StepOutcome> {
    let migrations: Migration[]
    try {
      migrations = await readMigrationsFromGit(candidate.gitDir, candidate.commit)
    } catch (err) {
      if (err instanceof MigrationError) return { status: 'failed', output: err.message }
      throw err
    }
    if (!migrations.length) return { status: 'skipped', output: `No migrations in ${MIGRATIONS_DIR}/` }
    const output: string[] = []

    const empty = new DatabaseSync(':memory:')
    empty.exec('PRAGMA foreign_keys = ON')
    try {
      applyMigrations(empty, migrations)
      output.push(`All ${migrations.length} migrations apply to an empty DB`)
    } catch (err) {
      return { status: 'failed', output: `On an empty DB: ${(err as Error).message}` }
    } finally {
      empty.close()
    }

    const production = dbPath(candidate.project)
    const tmp = mkdtempSync(join(tmpdir(), 'hobwork-dry-run-'))
    try {
      const copyPath = join(tmp, 'db.sqlite')
      if (existsSync(production)) await pool.copy(production, copyPath)
      const copy = openProjectDb(copyPath)
      try {
        const done = appliedMigrations(copy)
        const before = schemaOf(copy)
        const started = performance.now()
        let outcome
        try {
          outcome = applyMigrations(copy, migrations)
        } catch (err) {
          return { status: 'failed', output: `On a copy of the production DB: ${(err as Error).message}` }
        }
        const problems = [
          ...outcome.changed.map(
            (m) =>
              `${MIGRATIONS_DIR}/${m.name} changed after it was applied to the production DB. Applied migrations cannot change: undo the edit and add a new migration`,
          ),
          ...removedFromSchema(before, schemaOf(copy)).map(
            (problem) => `${problem}. Migrations must only add tables and columns, so older versions keep working after a restore`,
          ),
          ...(outcome.notStrict.length ? [notStrictMessage(outcome.notStrict)] : []),
        ]
        if (problems.length) return { status: 'failed', output: problems.join('\n') }
        if (!outcome.applied.length) {
          output.push(`No new migrations for the production DB (${done.size} applied)`)
        } else {
          output.push(
            `Applied ${outcome.applied.map((m) => m.name).join(', ')} to a copy of the production DB in ${Math.round(performance.now() - started)}ms`,
          )
        }
      } finally {
        copy.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    return { status: 'passed', output: output.join('\n') }
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
    const apply = () => {
      const db = openProjectDb(path)
      try {
        return applyMigrations(db, migrations)
      } finally {
        db.close()
      }
    }
    if (!existsSync(path)) await copyProduction(project, branch)
    if (!migrations.length) return
    const outcome = apply()
    if (outcome.changed.length) {
      await copyProduction(project, branch)
      apply()
    }
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

    async closeBranch(project: string, branch: string): Promise<void> {
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
