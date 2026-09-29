import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { DbRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import { repoPath, workspaceDir } from '../host.ts'
import { createProject } from '../projects.ts'
import { queryLogs } from '../runtime/logs.ts'
import { createTestHost } from '../test-host.ts'
import { FAKE_PROJECT, seedMain, type Files } from '../test-project.ts'
import { createDbPool } from './db-pool.ts'
import { createProjectData, type ProjectData } from './project-data.ts'

let host: ReturnType<typeof createTestHost>
let data: ProjectData

const SPOOLS = 'CREATE TABLE spools (id INTEGER PRIMARY KEY, color TEXT NOT NULL) STRICT;'

function sql(...statements: string[]): DbRequest {
  return { statements: statements.map((s) => ({ sql: s })), transaction: statements.length > 1 }
}

async function seed(migrations: Files): Promise<string> {
  return seedMain(host, 'filament', { ...FAKE_PROJECT, ...migrations })
}

async function deployed(migrations: Files) {
  const commit = await seed(migrations)
  await data.migrate('filament', commit)
}

async function dryRun(migrations: Files) {
  return data.dryRun({ project: 'filament', gitDir: repoPath(host, 'filament'), commit: await seed(migrations) })
}

beforeEach(async () => {
  host = createTestHost()
  data = createProjectData(host)
  await createProject(host, 'filament')
})

afterEach(async () => {
  await data.stop()
  host.dispose()
})

test('the project DB lives in the data dir and keeps rows across connections', async () => {
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  expect(existsSync(join(host.dataDir, 'projects', 'filament', 'db.sqlite'))).toBe(true)
  const insert = await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')", 'SELECT count(*) AS n FROM spools'))
  expect(insert).toEqual({
    ok: true,
    results: [
      { rows: [], changes: 1, lastInsertRowid: 1 },
      { rows: [{ n: 1 }], changes: 0, lastInsertRowid: 0 },
    ],
  })
  await data.stop()
  expect(await data.execute({ project: 'filament' }, sql('SELECT color FROM spools'))).toMatchObject({
    results: [{ rows: [{ color: 'red' }] }],
  })
})

test('deploy applies only new migrations and logs them', async () => {
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  await deployed({
    'migrations/0001_spools.sql': SPOOLS,
    'migrations/0002_grams.sql': 'ALTER TABLE spools ADD COLUMN grams REAL;',
  })
  const lines = queryLogs(host, { project: 'filament', limit: 10 }).map((l) => l.message)
  expect(lines).toEqual(['Applied migrations: 0001_spools.sql', 'Applied migrations: 0002_grams.sql'])
})

test('the dry run passes additive migrations and applies them to a copy only', async () => {
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  const outcome = await dryRun({
    'migrations/0001_spools.sql': SPOOLS,
    'migrations/0002_scans.sql': 'CREATE TABLE scans (id INTEGER PRIMARY KEY, spool_id INTEGER REFERENCES spools (id)) STRICT;',
  })
  expect(outcome.status).toBe('passed')
  expect(outcome.output).toContain('Applied 0002_scans.sql to a copy of the production DB')
  const tables = await data.execute({ project: 'filament' }, sql("SELECT name FROM sqlite_schema WHERE name = 'scans'"))
  expect(tables).toMatchObject({ results: [{ rows: [] }] })
})

test('the dry run is skipped without migrations', async () => {
  expect(await dryRun({})).toMatchObject({ status: 'skipped' })
})

test('the dry run fails with the SQL error, on production data too', async () => {
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')", "INSERT INTO spools (color) VALUES ('red')"))
  const syntax = await dryRun({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_bad.sql': 'CREATE TABLE (' })
  expect(syntax).toMatchObject({ status: 'failed', output: expect.stringContaining('On an empty DB: migrations/0002_bad.sql failed:') })
  const unique = await dryRun({
    'migrations/0001_spools.sql': SPOOLS,
    'migrations/0002_unique.sql': 'CREATE UNIQUE INDEX spools_color ON spools (color);',
  })
  expect(unique).toMatchObject({
    status: 'failed',
    output: expect.stringContaining('On a copy of the production DB: migrations/0002_unique.sql failed: UNIQUE constraint failed'),
  })
})

test.each([
  ['DROP TABLE', 'DROP TABLE spools;', 'Table spools was dropped or renamed'],
  ['DROP COLUMN', 'ALTER TABLE spools DROP COLUMN color;', 'Column spools.color was dropped or renamed'],
  ['RENAME TO', 'ALTER TABLE spools RENAME TO reels;', 'Table spools was dropped or renamed'],
  ['RENAME COLUMN', 'ALTER TABLE spools RENAME COLUMN color TO colour;', 'Column spools.color was dropped or renamed'],
])('the dry run refuses %s', async (_, migration, message) => {
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  const outcome = await dryRun({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_change.sql': migration })
  expect(outcome.status).toBe('failed')
  expect(outcome.output).toContain(message)
  expect(outcome.output).toContain('older versions keep working after a restore')
})

test('the dry run allows rebuilding a table under the same name with the same columns', async () => {
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  const rebuild = `CREATE TABLE spools_new (id INTEGER PRIMARY KEY, color TEXT NOT NULL CHECK (color != '')) STRICT;
INSERT INTO spools_new SELECT * FROM spools;
DROP TABLE spools;
ALTER TABLE spools_new RENAME TO spools;`
  const outcome = await dryRun({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_check.sql': rebuild })
  expect(outcome).toMatchObject({ status: 'passed' })
})

test('the dry run refuses edited migrations, tables without STRICT and symlinks', async () => {
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  const edited = await dryRun({ 'migrations/0001_spools.sql': `${SPOOLS}\n-- edited` })
  expect(edited).toMatchObject({ status: 'failed', output: expect.stringContaining('0001_spools.sql changed after it was applied') })
  const loose = await dryRun({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_loose.sql': 'CREATE TABLE loose (a);' })
  expect(loose).toMatchObject({ status: 'failed', output: expect.stringContaining('Not STRICT: loose') })
})

test('the dry run reads migrations from git and refuses symlinks', async () => {
  const outside = join(host.dataDir, 'outside.sql')
  writeFileSync(outside, 'CREATE TABLE secret (a TEXT) STRICT;')
  const work = join(host.dataDir, 'work')
  mkdirSync(join(work, 'migrations'), { recursive: true })
  symlinkSync(outside, join(work, 'migrations', '0001_link.sql'))
  const { git } = await import('../git.ts')
  await git(['init', '--quiet', '--initial-branch', 'main', work])
  await git(['add', '--all'], { cwd: work })
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'link'], { cwd: work })
  const commit = (await git(['rev-parse', 'HEAD'], { cwd: work })).trim()
  const outcome = await data.dryRun({ project: 'filament', gitDir: join(work, '.git'), commit })
  expect(outcome).toEqual({ status: 'failed', output: 'migrations/0001_link.sql must be a regular file' })
})

test('slow queries and DB size show up in the log and the status', async () => {
  await data.stop()
  data = createProjectData(host, { slowQueryMs: 0, sizeWarningBytes: 1 })
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  await data.execute({ project: 'filament' }, { ...sql("INSERT INTO spools (color) VALUES ('red')"), invocation: 999 })
  await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')"))
  const status = data.status('filament')
  expect(status.slowQueries).toMatchObject({ count: 2, last: { sql: "INSERT INTO spools (color) VALUES ('red')" } })
  expect(status.sizeBytes).toBeGreaterThan(0)
  expect(status.sizeWarning).toContain('over the 0.0 MB warning size')
  const events = queryLogs(host, { project: 'filament', limit: 20 }).filter((l) => l.event === 'db')
  // The same statement is logged once; the unknown invocation is dropped.
  expect(events.filter((l) => l.message.startsWith('Slow query'))).toEqual([expect.objectContaining({ invocationId: null, level: 'warn' })])
  expect(events.some((l) => l.message.startsWith('The hob DB is'))).toBe(true)
})

test('a query that runs too long is abandoned and the DB keeps working', async () => {
  await data.stop()
  data = createProjectData(host, { pool: createDbPool({ timeoutMs: 200 }) })
  const endless = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n'
  const outcome = await data.execute({ project: 'filament' }, sql(endless))
  expect(outcome).toEqual({ ok: false, error: { message: expect.stringContaining('did not finish within 0.2s'), code: 'timeout' } })
  expect(await data.execute({ project: 'filament' }, sql('SELECT 1 AS one'))).toMatchObject({ results: [{ rows: [{ one: 1 }] }] })
})

test('a branch DB starts as a copy of production and applies the branch migrations', async () => {
  await deployed({ 'migrations/0001_spools.sql': SPOOLS })
  await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')"))
  const files = join(workspaceDir(host, 'filament', 'dev'), 'files')
  mkdirSync(join(files, 'migrations'), { recursive: true })
  writeFileSync(join(files, 'migrations', '0001_spools.sql'), SPOOLS)
  await data.resetBranch('filament', 'dev')

  const onBranch = (request: DbRequest) => data.executeOnBranch('filament', 'dev', files, request)
  await onBranch(sql("INSERT INTO spools (color) VALUES ('blue')"))
  expect(await onBranch(sql('SELECT color FROM spools ORDER BY id'))).toMatchObject({
    results: [{ rows: [{ color: 'red' }, { color: 'blue' }] }],
  })
  expect(await data.execute({ project: 'filament' }, sql('SELECT count(*) AS n FROM spools'))).toMatchObject({
    results: [{ rows: [{ n: 1 }] }],
  })

  writeFileSync(join(files, 'migrations', '0002_grams.sql'), 'ALTER TABLE spools ADD COLUMN grams REAL;')
  expect(await onBranch(sql('SELECT grams FROM spools'))).toMatchObject({ ok: true })

  // Editing an applied migration starts the branch DB over from production.
  writeFileSync(join(files, 'migrations', '0002_grams.sql'), 'ALTER TABLE spools ADD COLUMN weight REAL;')
  expect(await onBranch(sql('SELECT color, weight FROM spools'))).toMatchObject({
    results: [{ rows: [{ color: 'red', weight: null }] }],
  })

  writeFileSync(join(files, 'migrations', '0003_bad.sql'), 'nonsense')
  expect(await onBranch(sql('SELECT 1'))).toMatchObject({
    ok: false,
    error: { code: 'migration', message: expect.stringContaining('0003_bad.sql failed') },
  })
})
