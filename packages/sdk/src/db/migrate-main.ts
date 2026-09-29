// Runs in a short-lived VM with the directory the host prepared mounted at
// /migrate: reads input.json, applies its migrations to db.sqlite there and
// prints one JSON line. The host takes back only db.sqlite, and checks it.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations, MigrationError, parseMigrations, type Migration, type MigrationFile } from './migrations.ts'

const DIR = '/migrate'

type Input = { files: MigrationFile[]; emptyCheck: boolean }

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON')
  return db
}

function applyTo(path: string, migrations: Migration[], journal?: string) {
  const db = open(path)
  try {
    if (journal) db.exec(`PRAGMA journal_mode = ${journal}`)
    applyMigrations(db, migrations)
  } finally {
    db.close()
  }
}

type Result = { ok: true } | { ok: false; stage: 'empty' | 'copy'; error: string }

let result: Result
try {
  const input = JSON.parse(readFileSync(`${DIR}/input.json`, 'utf8')) as Input
  const migrations = parseMigrations(input.files)
  result = { ok: true }
  if (input.emptyCheck) {
    try {
      applyTo(':memory:', migrations)
    } catch (err) {
      if (!(err instanceof MigrationError)) throw err
      result = { ok: false, stage: 'empty', error: err.message }
    }
  }
  // journal_mode = DELETE so one file comes back, without a WAL next to it.
  if (result.ok) applyTo(`${DIR}/db.sqlite`, migrations, 'DELETE')
} catch (err) {
  result = {
    ok: false,
    stage: 'copy',
    error: err instanceof MigrationError ? err.message : `The migration runner failed: ${(err as Error).message}`,
  }
}
console.log(JSON.stringify(result))
