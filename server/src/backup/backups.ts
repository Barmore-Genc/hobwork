import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishChange } from '../changes.ts'
import type { Host } from '../host.ts'
import { createScheduler } from '../runtime/scheduler.ts'
import type { BackupConfig } from './config.ts'
import { createKopia, type Kopia } from './kopia.ts'
import { stageBackup } from './stage.ts'

export type BackupTrigger = 'schedule' | 'manual'
export type BackupStatus = 'running' | 'succeeded' | 'failed'

export type BackupRun = {
  id: number
  trigger: BackupTrigger
  status: BackupStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  snapshotId: string | null
  totalBytes: number | null
  files: number | null
  uploadedBytes: number | null
  error: string | null
}

export class BackupBusyError extends Error {}

export type BackupLogger = { info(message: string): void; error(message: string): void }

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const COLUMNS = `id, trigger, status, started_at, finished_at, duration_ms, snapshot_id, total_bytes, file_count,
  uploaded_bytes, error`

export function stagingDir(dataDir: string): string {
  return join(dataDir, 'backup-staging')
}

export function kopiaDir(dataDir: string): string {
  return join(dataDir, 'kopia')
}

function lockPath(dataDir: string): string {
  return join(dataDir, 'backup.lock')
}

function toRun(row: Record<string, unknown>): BackupRun {
  const num = (v: unknown) => (v === null ? null : Number(v))
  return {
    id: Number(row.id),
    trigger: row.trigger as BackupTrigger,
    status: row.status as BackupStatus,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    durationMs: num(row.duration_ms),
    snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id),
    totalBytes: num(row.total_bytes),
    files: num(row.file_count),
    uploadedBytes: num(row.uploaded_bytes),
    error: row.error === null ? null : String(row.error),
  }
}

export function listBackupRuns(host: Host, limit = 20): BackupRun[] {
  return host.db.prepare(`SELECT ${COLUMNS} FROM backup_runs ORDER BY id DESC LIMIT ?`).all(limit).map(toRun)
}

export function lastSuccessfulRun(host: Host): BackupRun | undefined {
  const row = host.db
    .prepare(`SELECT ${COLUMNS} FROM backup_runs WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1`)
    .get()
  return row ? toRun(row) : undefined
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A file lock, so the host and the backup CLI never stage into the same
// directory at once.
function acquireLock(dataDir: string): () => void {
  const path = lockPath(dataDir)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' })
      return () => rmSync(path, { force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new BackupBusyError('A backup is already running')
      }
      rmSync(path, { force: true })
    }
  }
  throw new BackupBusyError('A backup is already running')
}

function lockHeld(dataDir: string): boolean {
  try {
    const pid = Number(readFileSync(lockPath(dataDir), 'utf8').trim())
    return pidAlive(pid)
  } catch {
    return false
  }
}

const consoleLogger: BackupLogger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
}

export function createBackups(
  host: Host,
  config: BackupConfig,
  options: { kopia?: Kopia; logger?: BackupLogger } = {},
) {
  const kopia = options.kopia ?? createKopia(config, kopiaDir(host.dataDir))
  const logger = options.logger ?? consoleLogger
  const scheduler = createScheduler(() => {
    void run('schedule').catch((err) => {
      if (err instanceof BackupBusyError) logger.info(`Scheduled backup skipped: ${err.message}`)
      else logger.error(`Backup failed: ${(err as Error).message}`)
    })
  })
  let running: Promise<BackupRun> | undefined

  async function execute(id: number, release: () => void): Promise<BackupRun> {
    const started = performance.now()
    const staging = stagingDir(host.dataDir)
    try {
      await kopia.ensureRepository()
      await kopia.applyRetention()
      const staged = await stageBackup(host.dataDir, staging)
      const snapshot = await kopia.snapshot(staging)
      host.db
        .prepare(
          `UPDATE backup_runs SET status = 'succeeded', finished_at = ${NOW}, duration_ms = ?, snapshot_id = ?,
            total_bytes = ?, file_count = ?, uploaded_bytes = ? WHERE id = ?`,
        )
        .run(
          Math.round(performance.now() - started),
          snapshot.id,
          snapshot.totalBytes,
          snapshot.files,
          snapshot.uploadedBytes ?? null,
          id,
        )
      logger.info(
        `Backup ${snapshot.id} done: ${staged.projects.length} hobs, ${snapshot.totalBytes} bytes, ${snapshot.uploadedBytes ?? 'unknown'} bytes uploaded`,
      )
    } catch (err) {
      const message = (err as Error).message
      host.db
        .prepare(`UPDATE backup_runs SET status = 'failed', finished_at = ${NOW}, duration_ms = ?, error = ? WHERE id = ?`)
        .run(Math.round(performance.now() - started), message, id)
      logger.error(`BACKUP FAILED: ${message}`)
    } finally {
      rmSync(staging, { recursive: true, force: true })
      release()
      publishChange(host.db, { kind: 'backups' })
    }
    return getRun(id)
  }

  function getRun(id: number): BackupRun {
    return toRun(host.db.prepare(`SELECT ${COLUMNS} FROM backup_runs WHERE id = ?`).get(id)!)
  }

  // Throws BackupBusyError when a backup is already running here or in the
  // CLI. `done` resolves with the finished run, also when it failed.
  function begin(trigger: BackupTrigger): { run: BackupRun; done: Promise<BackupRun> } {
    if (running) throw new BackupBusyError('A backup is already running')
    const release = acquireLock(host.dataDir)
    let id: number
    try {
      id = Number(host.db.prepare('INSERT INTO backup_runs (trigger) VALUES (?) RETURNING id').get(trigger)!.id)
    } catch (err) {
      release()
      throw err
    }
    publishChange(host.db, { kind: 'backups' })
    const done = execute(id, release)
    running = done
    void done.finally(() => {
      if (running === done) running = undefined
    })
    return { run: getRun(id), done }
  }

  async function run(trigger: BackupTrigger): Promise<BackupRun> {
    return begin(trigger).done
  }

  return {
    config,
    kopia,
    run,

    begin,

    // Runs left as running by a host that stopped are failed.
    schedule(): void {
      if (!lockHeld(host.dataDir)) {
        host.db
          .prepare(`UPDATE backup_runs SET status = 'failed', finished_at = ${NOW}, error = ? WHERE status = 'running'`)
          .run('Interrupted by a host restart')
      }
      if (config.schedule) scheduler.set('hobwork', { backup: { schedule: config.schedule } })
    },

    nextRun(): Date | undefined {
      return scheduler.list('hobwork')[0]?.next
    },

    running(): boolean {
      return running !== undefined || lockHeld(host.dataDir)
    },

    stop(): void {
      scheduler.stop()
    },
  }
}

export type Backups = ReturnType<typeof createBackups>
