import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { migrate } from './migrate.ts'

export const migrationsDir = resolve(import.meta.dirname, '../migrations')

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `)
  return db
}

export function openHostDb(path: string): DatabaseSync {
  const db = openDb(path)
  migrate(db, migrationsDir)
  return db
}
