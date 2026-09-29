import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { applyMigrations, MigrationError, parseMigrations } from '../../../packages/sdk/src/db/migrations.ts'
import type { DbRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import { repoPath, workspaceDir } from '../host.ts'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { migrationsOf } from '../test-workspace-vm.ts'
import { FAKE_PROJECT, seedMain, type Files } from '../test-project.ts'
import type { RunMigrationVm } from './migration-vm.ts'
import { createProjectData, type ProjectData } from './project-data.ts'

let host: ReturnType<typeof createTestHost>
let data: ProjectData
let runs: number
let lastOptions: Parameters<RunMigrationVm>[0] | undefined
// Runs after the fake runner has written its result, to play a hostile guest.
let tamper: ((dir: string) => void | Promise<void>) | undefined
let during: (() => Promise<void>) | undefined

const SPOOLS = 'CREATE TABLE spools (id INTEGER PRIMARY KEY, color TEXT NOT NULL) STRICT;'

function sql(...statements: string[]): DbRequest {
  return { statements: statements.map((s) => ({ sql: s })), transaction: statements.length > 1 }
}

// What packages/sdk/src/db/migrate-main.ts does in the VM, on the host, so the
// tests can change what comes back.
const fakeVm: RunMigrationVm = async (options) => {
  const { dir } = options
  lastOptions = options
  runs++
  await during?.()
  const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')) as { files: { name: string; sql: string }[] }
  const db = new DatabaseSync(join(dir, 'db.sqlite'))
  let result: object = { ok: true }
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    applyMigrations(db, parseMigrations(input.files))
  } catch (err) {
    if (!(err instanceof MigrationError)) throw err
    result = { ok: false, stage: 'copy', error: err.message }
  } finally {
    db.close()
  }
  await tamper?.(dir)
  return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '', timedOut: false }
}

async function seed(migrations: Files): Promise<string> {
  return seedMain(host, 'filament', { ...FAKE_PROJECT, ...migrations })
}

async function deploy(migrations: Files) {
  await data.migrate('filament', await seed(migrations))
}

const count = () => data.execute({ project: 'filament' }, sql('SELECT count(*) AS n FROM spools'))

beforeEach(async () => {
  runs = 0
  tamper = undefined
  during = undefined
  host = createTestHost()
  data = createProjectData(host, { runMigrationVm: fakeVm })
  await createProject(host, 'filament')
})

afterEach(async () => {
  await data.stop()
  host.dispose()
})

test('deploy migrates a copy in the VM and swaps it in, keeping the rows', async () => {
  await deploy({ 'migrations/0001_spools.sql': SPOOLS })
  await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')"))
  await deploy({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_grams.sql': 'ALTER TABLE spools ADD COLUMN grams REAL;' })
  expect(runs).toBe(2)
  expect(lastOptions).toMatchObject({ project: 'filament' })
  expect(lastOptions!.quotaBytes).toBeGreaterThan(1024 * 1024 * 1024)
  expect(await data.execute({ project: 'filament' }, sql('SELECT color, grams FROM spools'))).toMatchObject({
    results: [{ rows: [{ color: 'red', grams: null }] }],
  })
  expect(existsSync(`${data.dbPath('filament')}-wal`) && readFileSync(`${data.dbPath('filament')}-wal`).length > 0).toBe(false)
  // Nothing new to apply does not start a VM.
  await deploy({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_grams.sql': 'ALTER TABLE spools ADD COLUMN grams REAL;', 'notes.md': 'x' })
  expect(runs).toBe(2)
})

test('queries during a migration wait for the swap, so no write is lost', async () => {
  await deploy({ 'migrations/0001_spools.sql': SPOOLS })
  await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')"))
  let late: Promise<unknown> | undefined
  during = async () => {
    late = data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('blue')"))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await deploy({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_grams.sql': 'ALTER TABLE spools ADD COLUMN grams REAL;' })
  await late
  expect(await count()).toMatchObject({ results: [{ rows: [{ n: 2 }] }] })
  expect(await data.execute({ project: 'filament' }, sql('SELECT grams FROM spools'))).toMatchObject({ ok: true })
})

test('a failing migration leaves the production DB as it was', async () => {
  await deploy({ 'migrations/0001_spools.sql': SPOOLS })
  await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')"))
  await expect(
    deploy({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_bad.sql': 'ALTER TABLE spools ADD COLUMN grams REAL;\nnonsense' }),
  ).rejects.toThrow('0002_bad.sql failed')
  expect(await data.execute({ project: 'filament' }, sql('SELECT grams FROM spools'))).toMatchObject({ ok: false })
  expect(await count()).toMatchObject({ results: [{ rows: [{ n: 1 }] }] })
})

test.each([
  [
    'a symlink to the production DB',
    (dir: string, prod: string) => {
      rmSync(join(dir, 'db.sqlite'))
      symlinkSync(prod, join(dir, 'db.sqlite'))
    },
    'is a symlink',
  ],
  ['text', (dir: string) => writeFileSync(join(dir, 'db.sqlite'), 'not a database'), 'not an SQLite database'],
  [
    'a corrupt DB',
    (dir: string) => {
      const bytes = readFileSync(join(dir, 'db.sqlite'))
      bytes.fill(0, 4096, 8192)
      writeFileSync(join(dir, 'db.sqlite'), bytes)
    },
    'The migrated DB',
  ],
  [
    'a DB over the size limit',
    (dir: string) => truncateSync(join(dir, 'db.sqlite'), 600 * 1024 * 1024),
    'over the limit',
  ],
])('a VM that returns %s does not replace the production DB', async (_, hostile, message) => {
  await deploy({ 'migrations/0001_spools.sql': SPOOLS })
  await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')"))
  tamper = (dir) => hostile(dir, data.dbPath('filament'))
  await expect(
    deploy({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_grams.sql': 'ALTER TABLE spools ADD COLUMN grams REAL;' }),
  ).rejects.toThrow(message)
  expect(await count()).toMatchObject({ results: [{ rows: [{ n: 1 }] }] })
  expect(await data.execute({ project: 'filament' }, sql('SELECT grams FROM spools'))).toMatchObject({ ok: false })
})

test('the dry run checks the DB that comes back, not what the VM says', async () => {
  await deploy({ 'migrations/0001_spools.sql': SPOOLS })
  const commit = await seed({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_drop.sql': 'DROP TABLE spools;' })
  const outcome = await data.dryRun({ project: 'filament', gitDir: repoPath(host, 'filament'), commit })
  expect(outcome).toMatchObject({ status: 'failed', output: expect.stringContaining('Table spools was dropped or renamed') })
  const loose = await seed({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_loose.sql': 'CREATE TABLE loose (a);' })
  expect(await data.dryRun({ project: 'filament', gitDir: repoPath(host, 'filament'), commit: loose })).toMatchObject({
    status: 'failed',
    output: expect.stringContaining('Not STRICT: loose'),
  })
  const good = await seed({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_scans.sql': 'CREATE TABLE scans (id INTEGER PRIMARY KEY) STRICT;' })
  expect(await data.dryRun({ project: 'filament', gitDir: repoPath(host, 'filament'), commit: good })).toMatchObject({ status: 'passed' })
  tamper = (dir) => writeFileSync(join(dir, 'db.sqlite'), 'junk')
  expect(await data.dryRun({ project: 'filament', gitDir: repoPath(host, 'filament'), commit: good })).toMatchObject({
    status: 'failed',
    output: expect.stringContaining('not an SQLite database'),
  })
})

test('a branch DB applies pending migrations in the VM and only when something changed', async () => {
  await deploy({ 'migrations/0001_spools.sql': SPOOLS })
  await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')"))
  const files = join(workspaceDir(host, 'filament', 'dev'), 'files')
  mkdirSync(join(files, 'migrations'), { recursive: true })
  writeFileSync(join(files, 'migrations', '0001_spools.sql'), SPOOLS)
  await data.resetBranch('filament', 'dev')
  const onBranch = (request: DbRequest) => data.executeOnBranch('filament', 'dev', migrationsOf(host, files), request)
  expect(await onBranch(sql('SELECT color FROM spools'))).toMatchObject({ results: [{ rows: [{ color: 'red' }] }] })
  expect(runs).toBe(1)
  writeFileSync(join(files, 'migrations', '0002_grams.sql'), 'ALTER TABLE spools ADD COLUMN grams REAL;')
  expect(await onBranch(sql('SELECT color, grams FROM spools'))).toMatchObject({ results: [{ rows: [{ color: 'red', grams: null }] }] })
  expect(runs).toBe(2)
  await onBranch(sql('SELECT 1'))
  expect(runs).toBe(2)
})

test('without a VM, migrations on the host cannot attach other DBs, vacuum into files or load extensions', async () => {
  await data.stop()
  data = createProjectData(host)
  const outside = join(host.dataDir, 'stolen.sqlite')
  const attach = `ATTACH DATABASE '${outside}' AS other; CREATE TABLE other.t (a);`
  await expect(deploy({ 'migrations/0001_attach.sql': attach })).rejects.toThrow('0001_attach.sql failed')
  expect(existsSync(outside)).toBe(false)
  const vacuum = `COMMIT; VACUUM INTO '${outside}';`
  await expect(deploy({ 'migrations/0001_vacuum.sql': vacuum })).rejects.toThrow('VACUUM is not allowed')
  expect(existsSync(outside)).toBe(false)
  await expect(deploy({ 'migrations/0001_ext.sql': "SELECT load_extension('/tmp/evil');" })).rejects.toThrow('0001_ext.sql failed')
})
