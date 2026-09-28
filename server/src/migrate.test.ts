import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDb, openHostDb } from './db.ts'
import { migrate } from './migrate.ts'

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobwork-migrate-'))
  db = openDb(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, sql: string) {
  writeFileSync(join(dir, name), sql)
}

test('applies migrations in numeric order and records them', () => {
  write('0010_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT;')
  write('0002_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;')
  expect(migrate(db, dir)).toEqual([2, 10])
  const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
  expect(rows.map((r) => r.name)).toEqual(['0002_a.sql', '0010_b.sql'])
})

test('skips migrations that already ran', () => {
  write('0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;')
  migrate(db, dir)
  write('0002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT;')
  expect(migrate(db, dir)).toEqual([2])
  expect(migrate(db, dir)).toEqual([])
})

test('rolls back a failing migration and stops', () => {
  write('0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;')
  write('0002_bad.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY) STRICT; SELECT * FROM missing;')
  write('0003_d.sql', 'CREATE TABLE d (id INTEGER PRIMARY KEY) STRICT;')
  expect(() => migrate(db, dir)).toThrow('0002_bad.sql')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  const names = tables.map((t) => t.name)
  expect(names).toContain('a')
  expect(names).not.toContain('c')
  expect(names).not.toContain('d')
  expect(db.prepare('SELECT version FROM schema_migrations').all()).toHaveLength(1)
})

test('rejects duplicate versions', () => {
  write('0001_a.sql', 'SELECT 1;')
  write('0001_b.sql', 'SELECT 1;')
  expect(() => migrate(db, dir)).toThrow('Duplicate migration version 1')
})

test('host DB migrations create strict tables and apply pragmas', () => {
  const host = openHostDb(':memory:')
  const projects = host.prepare("SELECT strict FROM pragma_table_list('projects')").get()
  expect(projects?.strict).toBe(1)
  expect(host.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  expect(host.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
  host.close()
})
