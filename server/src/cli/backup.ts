import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createBackups, kopiaDir } from '../backup/backups.ts'
import { createKopia } from '../backup/kopia.ts'
import { HOST_DB_FILE } from '../backup/stage.ts'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'
import { SECRET_KEY_FILE } from '../secrets.ts'
import { HOST_KEY_FILE } from '../ssh/gateway.ts'

const USAGE = `Usage:
  pnpm --filter @hobwork/server backup now
  pnpm --filter @hobwork/server backup list
  pnpm --filter @hobwork/server backup verify [--percent <n>]
  pnpm --filter @hobwork/server backup restore <empty-dir> [--snapshot <id>]

now backs up the data dir while the host keeps running. verify reads every
snapshot's directories and a random share of the files (default 10 percent).
restore writes a snapshot (default: the newest) into a new data dir; start the
host with HOBWORK_DATA_DIR set to it.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { percent: { type: 'string' }, snapshot: { type: 'string' } },
})
const [command, ...rest] = positionals

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function mb(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? '?' : `${(bytes / 1e6).toFixed(1)} MB`
}

const config = loadConfig()
const backup = config.backup ?? fail('Backups are not set up. Set HOBWORK_BACKUP_S3_BUCKET and the other HOBWORK_BACKUP_* variables')

try {
  if (command === 'now') {
    const db = openHostDb(join(config.dataDir, HOST_DB_FILE))
    try {
      const silent = { info() {}, error() {} }
      const run = await createBackups({ db, dataDir: config.dataDir }, backup, { logger: silent }).run('manual')
      if (run.status !== 'succeeded') fail(`Backup failed: ${run.error}`)
      console.log(`Snapshot ${run.snapshotId}: ${run.files} files, ${mb(run.totalBytes)}, ${mb(run.uploadedBytes)} uploaded in ${((run.durationMs ?? 0) / 1000).toFixed(1)}s`)
    } finally {
      db.close()
    }
  } else if (command === 'list') {
    const kopia = createKopia(backup, kopiaDir(config.dataDir))
    await kopia.ensureRepository({ create: false })
    for (const s of await kopia.list()) {
      console.log(`${s.id}\t${s.startTime}\t${s.files} files\t${mb(s.totalBytes)}\t${s.retention.join(',')}`)
    }
  } else if (command === 'verify') {
    const percent = Number(values.percent ?? 10)
    if (!(percent >= 0 && percent <= 100)) fail('--percent must be a number from 0 to 100')
    const kopia = createKopia(backup, kopiaDir(config.dataDir))
    await kopia.ensureRepository({ create: false })
    console.log(await kopia.verify(percent))
  } else if (command === 'restore') {
    const target = resolve(rest[0] ?? fail(USAGE))
    if (existsSync(target) && readdirSync(target).length) fail(`${target} is not empty. Restore into a new directory`)
    // Kopia's connection for the restore lives outside the target, which the
    // restored host then connects again on its first backup.
    const scratch = mkdtempSync(join(tmpdir(), 'hobwork-restore-'))
    try {
      const kopia = createKopia(backup, scratch)
      await kopia.ensureRepository({ create: false })
      const id = values.snapshot ?? (await kopia.list()).at(-1)?.id ?? fail('The repository has no snapshots')
      mkdirSync(target, { recursive: true, mode: 0o700 })
      await kopia.restore(id, target)
      for (const file of [SECRET_KEY_FILE, HOST_KEY_FILE]) {
        if (existsSync(join(target, file))) chmodSync(join(target, file), 0o600)
      }
      console.log(`Restored snapshot ${id} into ${target}. Start the host with HOBWORK_DATA_DIR=${target}`)
      if (!existsSync(join(target, SECRET_KEY_FILE))) {
        console.log('The snapshot has no secret.key, so set HOBWORK_SECRET_KEY to the key the old host used')
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  } else fail(USAGE)
} catch (err) {
  fail((err as Error).message)
}
