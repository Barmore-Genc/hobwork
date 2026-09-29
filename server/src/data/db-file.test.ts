import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DbFileError, takeDbFile } from './db-file.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobwork-db-file-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeDb(path: string) {
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE spools (id INTEGER PRIMARY KEY, color TEXT NOT NULL) STRICT; INSERT INTO spools (color) VALUES ('red')")
  db.close()
}

const LIMIT = 10 * 1024 * 1024

test('a regular SQLite file is copied to a new file', () => {
  makeDb(join(dir, 'in.sqlite'))
  takeDbFile(join(dir, 'in.sqlite'), join(dir, 'out.sqlite'), LIMIT)
  const db = new DatabaseSync(join(dir, 'out.sqlite'))
  expect(db.prepare('SELECT color FROM spools').all()).toEqual([{ color: 'red' }])
  db.close()
})

test('a symlink is refused, also one to a valid DB', () => {
  makeDb(join(dir, 'real.sqlite'))
  symlinkSync(join(dir, 'real.sqlite'), join(dir, 'in.sqlite'))
  expect(() => takeDbFile(join(dir, 'in.sqlite'), join(dir, 'out.sqlite'), LIMIT)).toThrow('is a symlink')
  expect(existsSync(join(dir, 'out.sqlite'))).toBe(false)
})

test('a directory and a FIFO are refused', () => {
  mkdirSync(join(dir, 'in.sqlite'))
  expect(() => takeDbFile(join(dir, 'in.sqlite'), join(dir, 'out.sqlite'), LIMIT)).toThrow('not a regular file')
  execFileSync('mkfifo', [join(dir, 'fifo')])
  expect(() => takeDbFile(join(dir, 'fifo'), join(dir, 'out.sqlite'), LIMIT)).toThrow('not a regular file')
})

test('a missing file is refused', () => {
  expect(() => takeDbFile(join(dir, 'nothing'), join(dir, 'out.sqlite'), LIMIT)).toThrow('is missing')
})

test('a file over the size limit is refused', () => {
  makeDb(join(dir, 'in.sqlite'))
  expect(() => takeDbFile(join(dir, 'in.sqlite'), join(dir, 'out.sqlite'), 1024)).toThrow('over the limit')
  expect(existsSync(join(dir, 'out.sqlite'))).toBe(false)
})

test('a file that is not SQLite is refused', () => {
  writeFileSync(join(dir, 'in.sqlite'), 'just some text')
  expect(() => takeDbFile(join(dir, 'in.sqlite'), join(dir, 'out.sqlite'), LIMIT)).toThrow('not an SQLite database')
})

test('a corrupt DB is refused', () => {
  makeDb(join(dir, 'in.sqlite'))
  const bytes = readFileSync(join(dir, 'in.sqlite'))
  // Zeroing the table's page keeps the header valid and breaks the schema.
  bytes.fill(0, 4096, 8192)
  writeFileSync(join(dir, 'in.sqlite'), bytes)
  expect(() => takeDbFile(join(dir, 'in.sqlite'), join(dir, 'out.sqlite'), LIMIT)).toThrow(DbFileError)
  expect(existsSync(join(dir, 'out.sqlite'))).toBe(false)
})

test('it never overwrites an existing file', () => {
  makeDb(join(dir, 'in.sqlite'))
  writeFileSync(join(dir, 'out.sqlite'), 'keep')
  expect(() => takeDbFile(join(dir, 'in.sqlite'), join(dir, 'out.sqlite'), LIMIT)).toThrow()
  expect(readFileSync(join(dir, 'out.sqlite'), 'utf8')).toBe('keep')
})
