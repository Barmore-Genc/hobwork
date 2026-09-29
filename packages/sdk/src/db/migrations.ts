// Hob DB migrations: migrations/NNNN_name.sql, applied in order and
// recorded in the DB. Shared by the host (deploy, dry run, branch DBs) and
// `@hobwork/sdk/testing`.
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const MIGRATIONS_TABLE = 'hobwork_migrations'
export const MIGRATIONS_DIR = 'migrations'

const FILE_NAME = /^(\d+)_[A-Za-z0-9_.-]+\.sql$/

export type MigrationFile = { name: string; sql: string }

export type Migration = MigrationFile & { version: number; checksum: string }

export class MigrationError extends Error {}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

// Only .sql files count. Anything else in migrations/ (like .gitkeep) is ignored.
export function parseMigrations(files: MigrationFile[]): Migration[] {
  const migrations: Migration[] = []
  const versions = new Map<number, string>()
  for (const file of files) {
    if (!file.name.endsWith('.sql')) continue
    const match = FILE_NAME.exec(file.name)
    if (!match) {
      throw new MigrationError(`${MIGRATIONS_DIR}/${file.name} must be named like 0001_add_spools.sql`)
    }
    const version = Number(match[1])
    const other = versions.get(version)
    if (other) throw new MigrationError(`${MIGRATIONS_DIR}/${other} and ${file.name} have the same number ${version}`)
    versions.set(version, file.name)
    migrations.push({ ...file, version, checksum: checksum(file.sql) })
  }
  return migrations.sort((a, b) => a.version - b.version)
}

export type AppliedMigration = { version: number; name: string; checksum: string }

export function appliedMigrations(db: DatabaseSync): Map<number, AppliedMigration> {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(MIGRATIONS_TABLE)
  if (!exists) return new Map()
  return new Map(
    db
      .prepare(`SELECT version, name, checksum FROM ${MIGRATIONS_TABLE}`)
      .all()
      .map((row) => [Number(row.version), { version: Number(row.version), name: String(row.name), checksum: String(row.checksum) }]),
  )
}

function tables(db: DatabaseSync): Map<string, { strict: boolean; type: string }> {
  return new Map(
    db
      .prepare("SELECT name, type, strict FROM pragma_table_list WHERE schema = 'main'")
      .all()
      .map((row) => [String(row.name), { strict: row.strict === 1, type: String(row.type) }]),
  )
}

export type MigrationOutcome = {
  applied: Migration[]
  // Applied migrations whose file changed since.
  changed: Migration[]
  // Tables the applied migrations created without STRICT.
  notStrict: string[]
}

// Applies the migrations the DB has not seen, each in its own transaction. A
// failing migration throws a MigrationError naming it; the ones before it stay applied.
export function applyMigrations(db: DatabaseSync, migrations: Migration[]): MigrationOutcome {
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`)
  const applied = appliedMigrations(db)
  const outcome: MigrationOutcome = { applied: [], changed: [], notStrict: [] }
  const before = tables(db)
  for (const migration of migrations) {
    const done = applied.get(migration.version)
    if (done) {
      if (done.checksum !== migration.checksum) outcome.changed.push(migration)
      continue
    }
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES (?, ?, ?)`).run(
        migration.version,
        migration.name,
        migration.checksum,
      )
      db.exec('COMMIT')
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw new MigrationError(`${MIGRATIONS_DIR}/${migration.name} failed: ${(err as Error).message}`, { cause: err })
    }
    outcome.applied.push(migration)
  }
  for (const [name, table] of tables(db)) {
    if (!before.has(name) && table.type === 'table' && !table.strict && !name.startsWith('sqlite_')) {
      outcome.notStrict.push(name)
    }
  }
  return outcome
}

export function notStrictMessage(tables: string[]): string {
  return `Create tables as STRICT (CREATE TABLE ... ( ... ) STRICT) so SQLite enforces column types. Not STRICT: ${tables.join(', ')}`
}
