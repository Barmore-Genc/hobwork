import type { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE_PATTERN = /^(\d+)_.+\.sql$/

export function migrate(db: DatabaseSync, dir: string): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`)

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row.version)),
  )

  const files = readdirSync(dir)
    .flatMap((name) => {
      const match = FILE_PATTERN.exec(name)
      return match ? [{ name, version: Number(match[1]) }] : []
    })
    .sort((a, b) => a.version - b.version)

  const seen = new Set<number>()
  for (const { version } of files) {
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`)
    seen.add(version)
  }

  const ran: number[] = []
  for (const { name, version } of files) {
    if (applied.has(version)) continue
    const sql = readFileSync(join(dir, name), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${name} failed`, { cause: err })
    }
    ran.push(version)
  }
  return ran
}
