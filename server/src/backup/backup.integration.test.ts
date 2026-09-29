// Backs up to MinIO with Kopia, both in Docker (see dev/backups/README.md):
// HOBWORK_BACKUP_TESTS=1 pnpm --filter @hobwork/server test src/backup
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { openDb, openHostDb } from '../db.ts'
import { git } from '../git.ts'
import { repoPath, type Host } from '../host.ts'
import { createProject, listProjects } from '../projects.ts'
import { createSecretStore, loadSecretKey } from '../secrets.ts'
import { freePort } from '../test-web.ts'
import { createBackups, kopiaDir, type BackupRun } from './backups.ts'
import type { BackupConfig } from './config.ts'
import { createKopia } from './kopia.ts'

const repoRoot = resolve(import.meta.dirname, '../../..')
const compose = join(repoRoot, 'dev/backups/compose.yaml')
const silent = { info() {}, error() {} }

describe.runIf(process.env.HOBWORK_BACKUP_TESTS === '1')('backups to MinIO', () => {
  let root: string
  let dataDir: string
  let host: Host
  let config: BackupConfig
  let env: Record<string, string>

  beforeAll(() => {
    execFileSync('docker', ['compose', '-f', compose, 'up', '-d', '--wait'], { stdio: 'ignore' })
    root = mkdtempSync(join(tmpdir(), 'hobwork-backup-it-'))
    dataDir = join(root, 'data')
    host = { db: openHostDb(join(dataDir, 'hobwork.db')), dataDir }
    config = {
      kopiaBin: join(repoRoot, 'dev/backups/kopia'),
      endpoint: 'localhost:19000',
      disableTls: true,
      bucket: 'hobwork',
      prefix: `test-${randomUUID()}/`,
      accessKeyId: 'hobwork',
      secretAccessKey: 'hobwork-dev-secret',
      password: randomBytes(16).toString('hex'),
      retention: { daily: 14, weekly: 8, monthly: 12 },
    }
    env = {
      HOBWORK_BACKUP_S3_BUCKET: config.bucket,
      HOBWORK_BACKUP_S3_ENDPOINT: 'http://localhost:19000',
      HOBWORK_BACKUP_S3_PREFIX: config.prefix,
      HOBWORK_BACKUP_S3_ACCESS_KEY_ID: config.accessKeyId,
      HOBWORK_BACKUP_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
      HOBWORK_BACKUP_PASSWORD: config.password,
      HOBWORK_KOPIA_BIN: config.kopiaBin,
    }
  })

  afterAll(() => {
    host?.db.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('backs up incrementally and restores into a working host', { timeout: 180_000 }, async () => {
    await createProject(host, 'filament')
    await createProject(host, 'archive')
    const secrets = createSecretStore(host, loadSecretKey(dataDir))
    secrets.create(
      { name: 'Spoolman', value: 'spool-token', hosts: ['spoolman.example'], assign: { project: 'filament', envName: 'SPOOLMAN_TOKEN' } },
      { kind: 'host' },
    )
    const spools = openDb(join(dataDir, 'projects', 'filament', 'db.sqlite'))
    spools.exec('CREATE TABLE spools (name TEXT NOT NULL) STRICT')
    spools.prepare('INSERT INTO spools VALUES (?)').run('PLA black')
    // Incompressible and unchanged between the two backups.
    const archive = openDb(join(dataDir, 'projects', 'archive', 'db.sqlite'))
    archive.exec('CREATE TABLE blobs (data BLOB NOT NULL) STRICT')
    for (let i = 0; i < 160; i++) archive.prepare('INSERT INTO blobs VALUES (?)').run(randomBytes(64 * 1024))
    archive.close()

    const backups = createBackups(host, config, { logger: silent })
    const first = await backups.run('manual')
    expect(first, first.error ?? '').toMatchObject({ status: 'succeeded' })

    spools.prepare('INSERT INTO spools VALUES (?)').run('PETG orange')
    spools.close()
    const second: BackupRun = await backups.run('schedule')
    expect(second, second.error ?? '').toMatchObject({ status: 'succeeded' })
    expect(first.uploadedBytes).toBeGreaterThan(10_000_000)
    expect(second.totalBytes).toBeGreaterThan(10_000_000)
    expect(second.uploadedBytes).toBeLessThan(first.uploadedBytes! / 5)

    const kopia = createKopia(config, kopiaDir(dataDir))
    expect((await kopia.list()).map((s) => s.id)).toEqual([first.snapshotId, second.snapshotId])
    await kopia.verify(100)

    const target = join(root, 'restored')
    const restore = await promisify(execFile)(
      process.execPath,
      [join(repoRoot, 'server/src/cli/backup.ts'), 'restore', target],
      { env: { ...process.env, ...env, HOBWORK_DATA_DIR: dataDir } },
    )
    expect(restore.stdout).toContain(`Restored snapshot ${second.snapshotId}`)

    expect(statSync(join(target, 'secret.key')).mode & 0o777).toBe(0o600)
    const restored: Host = { db: openHostDb(join(target, 'hobwork.db')), dataDir: target }
    try {
      expect(listProjects(restored).map((p) => p.name)).toEqual(['archive', 'filament'])
      const restoredSecrets = createSecretStore(restored, loadSecretKey(target))
      expect(restoredSecrets.forSandbox('filament')).toEqual({
        SPOOLMAN_TOKEN: { value: 'spool-token', hosts: ['spoolman.example'] },
      })
      const db = new DatabaseSync(join(target, 'projects', 'filament', 'db.sqlite'), { readOnly: true })
      expect(db.prepare('SELECT name FROM spools ORDER BY rowid').all().map((r) => r.name)).toEqual(['PLA black', 'PETG orange'])
      db.close()
      expect(await git(['--git-dir', repoPath(restored, 'filament'), 'rev-parse', 'main'])).toBe(
        await git(['--git-dir', repoPath(host, 'filament'), 'rev-parse', 'main']),
      )
    } finally {
      restored.db.close()
    }

    const port = await freePort()
    const child = spawn(process.execPath, [join(repoRoot, 'server/src/index.ts')], {
      env: {
        ...process.env,
        HOBWORK_DATA_DIR: target,
        HOBWORK_PORT: String(port),
        HOBWORK_SSH_PORT: 'off',
        HOBWORK_IMAGE_DIR: join(root, 'no-image'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk))
    try {
      await expect
        .poll(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined))?.status, {
          timeout: 20_000,
          interval: 200,
        })
        .toBe(200)
      expect(output).not.toMatch(/error/i)
    } finally {
      child.kill()
    }
  })
})
