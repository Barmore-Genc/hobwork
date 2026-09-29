import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { firstKeyword, splitStatements } from '../src/db/sql.ts'
import { MAX_ROWS } from '../src/db/execute.ts'
import { createTestContext, createTestDb } from '../src/testing.ts'

const migrations = new URL('./fixtures/migrations', import.meta.url).pathname
const db = () => createTestDb({ migrations })
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('runs, queries and returns rows with their types', async () => {
  const spools = db()
  const insert = await spools.run('INSERT INTO spools (color, grams, label) VALUES (?, ?, ?)', [
    'red',
    812.5,
    new Uint8Array([1, 2, 3]),
  ])
  expect(insert).toEqual({ changes: 1, lastInsertRowid: 1 })
  await spools.run('INSERT INTO spools (color, grams) VALUES (:color, :grams)', { color: 'blue', grams: 10n })
  expect(await spools.query('SELECT id, color, grams, label FROM spools ORDER BY id')).toEqual([
    { id: 1, color: 'red', grams: 812.5, label: new Uint8Array([1, 2, 3]) },
    { id: 2, color: 'blue', grams: 10, label: null },
  ])
  expect(await spools.get<{ n: number }>('SELECT count(*) AS n FROM spools WHERE color = ?', ['red'])).toEqual({ n: 1 })
  expect(await spools.get('SELECT * FROM spools WHERE id = 99')).toBeUndefined()
  expect(await spools.query('SELECT ? AS yes', [true])).toEqual([{ yes: 1 }])
})

test('RETURNING gives rows and the change count', async () => {
  const spools = db()
  const [result] = await spools.batch([{ sql: "INSERT INTO spools (color) VALUES ('red') RETURNING id, color" }])
  expect(result).toEqual({ rows: [{ id: 1, color: 'red' }], changes: 1, lastInsertRowid: 1 })
})

test('batch runs in one transaction and rolls back when a statement fails', async () => {
  const spools = db()
  const ok = await spools.batch([
    { sql: "INSERT INTO spools (color) VALUES ('red')" },
    { sql: 'INSERT INTO scans (spool_id) VALUES (last_insert_rowid())' },
    { sql: 'SELECT count(*) AS n FROM scans' },
  ])
  expect(ok[2]?.rows).toEqual([{ n: 1 }])
  const failed = spools.batch([
    { sql: "INSERT INTO spools (color) VALUES ('green')" },
    { sql: 'INSERT INTO scans (spool_id) VALUES (?)', params: [42] },
  ])
  await expect(failed).rejects.toMatchObject({ name: 'DbError', statement: 1, message: 'FOREIGN KEY constraint failed' })
  expect(await spools.query('SELECT color FROM spools')).toEqual([{ color: 'red' }])
})

test.each([
  ['several statements', 'SELECT 1; SELECT 2', 'Each SQL string must hold one statement'],
  ['schema changes', 'CREATE TABLE x (a INTEGER) STRICT', 'Add a migration in migrations/'],
  ['schema changes after a comment', '/* x */ drop table spools', 'Add a migration in migrations/'],
  ['temp tables', 'CREATE TEMP TABLE x (a)', 'Add a migration in migrations/'],
  ['indexes through a CTE-free path', 'REINDEX; ANALYZE', 'Each SQL string must hold one statement'],
  ['interactive transactions', 'BEGIN', 'Use ctx.db.batch'],
  ['savepoints', 'SAVEPOINT a', 'Use ctx.db.batch'],
  ['ATTACH', "ATTACH DATABASE '/etc/hosts' AS h", 'ATTACH and DETACH are not allowed'],
  ['VACUUM INTO', "VACUUM INTO '/tmp/copy.db'", 'VACUUM is not allowed'],
  ['state-changing PRAGMAs', 'PRAGMA foreign_keys = OFF', 'PRAGMA foreign_keys is not allowed'],
  ['PRAGMA functions', "SELECT * FROM pragma_journal_mode", 'PRAGMA journal_mode is not allowed'],
  ['loading extensions', "SELECT load_extension('x')", 'Extensions cannot be loaded'],
  ['writing the migration record', 'DELETE FROM hobwork_migrations', 'hobwork_migrations belongs to Hobwork'],
  ['empty SQL', ' -- nothing ', 'SQL is empty'],
])('refuses %s', async (_, sql, message) => {
  await expect(db().query(sql)).rejects.toThrow(message)
})

test('allows schema introspection', async () => {
  const columns = await db().query<{ name: string }>('SELECT name FROM pragma_table_info(?)', ['spools'])
  expect(columns.map((c) => c.name)).toEqual(['id', 'color', 'grams', 'label'])
  expect(await db().query("PRAGMA table_info('scans')")).toHaveLength(2)
  expect(await db().query('SELECT version, name FROM hobwork_migrations')).toEqual([
    { version: 1, name: '0001_spools.sql' },
    { version: 2, name: '0002_scans.sql' },
  ])
})

test('SQL errors carry SQLite messages', async () => {
  const spools = db()
  await spools.run("INSERT INTO spools (color) VALUES ('red')")
  await expect(spools.run("INSERT INTO spools (color) VALUES ('red')")).rejects.toThrow('UNIQUE constraint failed: spools.color')
  await expect(spools.run("INSERT INTO spools (color, grams) VALUES ('x', 'heavy')")).rejects.toThrow(
    'cannot store TEXT value in REAL column spools.grams',
  )
  await expect(spools.query('SELECT nope FROM spools')).rejects.toThrow('no such column: nope')
})

test('refuses results beyond the row limit', async () => {
  const sql = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= ${MAX_ROWS}) SELECT i FROM n`
  await expect(db().query(sql)).rejects.toThrow(`more than ${MAX_ROWS} rows`)
})

test('each test DB starts empty', async () => {
  await db().run("INSERT INTO spools (color) VALUES ('red')")
  expect(await db().query('SELECT * FROM spools')).toEqual([])
})

test('migrations must create STRICT tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobwork-sdk-test-'))
  dirs.push(dir)
  writeFileSync(join(dir, '0001_loose.sql'), 'CREATE TABLE loose (a TEXT);')
  expect(() => createTestDb({ migrations: dir })).toThrow('Not STRICT: loose')
})

test('a failing migration names its file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobwork-sdk-test-'))
  dirs.push(dir)
  writeFileSync(join(dir, '0001_bad.sql'), 'CREATE TABLE (')
  writeFileSync(join(dir, 'notes.md'), 'ignored')
  expect(() => createTestDb({ migrations: dir })).toThrow(/^migrations\/0001_bad.sql failed: /)
  writeFileSync(join(dir, 'bad-name.sql'), '')
  expect(() => createTestDb({ migrations: dir })).toThrow('migrations/bad-name.sql must be named like 0001_add_spools.sql')
})

test('createTestContext fills in a test DB and refuses unstubbed fetch', async () => {
  const ctx = createTestContext({ secrets: { API_KEY: 'placeholder' } })
  expect(await ctx.db.query('SELECT 1 AS one')).toEqual([{ one: 1 }])
  expect(ctx.secrets.API_KEY).toBe('placeholder')
  await expect(ctx.fetch('https://example.com')).rejects.toThrow('ctx.fetch is not stubbed')
})

test('splits statements outside strings and comments', () => {
  expect(splitStatements("SELECT ';' AS a; -- x;\n SELECT \"b;\" /* ; */ ;")).toEqual(["SELECT ';' AS a", 'SELECT "b;"'])
  expect(splitStatements("SELECT 'it''s; fine'")).toEqual(["SELECT 'it''s; fine'"])
  expect(firstKeyword('-- hi\n  /* x */ vacuum')).toBe('VACUUM')
})
