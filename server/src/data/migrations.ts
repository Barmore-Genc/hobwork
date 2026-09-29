import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  MigrationError,
  parseMigrations,
  type Migration,
} from '../../../packages/sdk/src/db/migrations.ts'
import { git } from '../git.ts'

// Read from git rather than a checkout, so a symlink in the repo cannot make
// the host read a file outside it.
export async function readMigrationsFromGit(gitDir: string, commit: string): Promise<Migration[]> {
  const listing = await git(['--git-dir', gitDir, 'ls-tree', '-z', commit, `${MIGRATIONS_DIR}/`])
  const files: { name: string; sql: string }[] = []
  for (const entry of listing.split('\0').filter(Boolean)) {
    const [meta = '', path = ''] = entry.split('\t')
    const [mode, type, object = ''] = meta.split(' ')
    const name = path.slice(MIGRATIONS_DIR.length + 1)
    if (!name.endsWith('.sql')) continue
    if (type !== 'blob' || mode === '120000') throw new MigrationError(`${path} must be a regular file`)
    files.push({ name, sql: await git(['--git-dir', gitDir, 'cat-file', 'blob', object]) })
  }
  return parseMigrations(files)
}

// For a branch checkout the VM can write to: symlinks are refused rather than
// followed, for the same reason as above.
export function readMigrationsFromDir(dir: string): Migration[] {
  const migrationsDir = join(dir, MIGRATIONS_DIR)
  let stat
  try {
    stat = lstatSync(migrationsDir)
  } catch {
    return []
  }
  if (!stat.isDirectory()) throw new MigrationError(`${MIGRATIONS_DIR} must be a directory`)
  const files: { name: string; sql: string }[] = []
  for (const name of readdirSync(migrationsDir)) {
    if (!name.endsWith('.sql')) continue
    const path = join(migrationsDir, name)
    if (!lstatSync(path).isFile()) throw new MigrationError(`${MIGRATIONS_DIR}/${name} must be a regular file`)
    files.push({ name, sql: readFileSync(path, 'utf8') })
  }
  return parseMigrations(files)
}

type SchemaObject = { type: string; columns: Set<string> }

// Tables and views with their columns, without SQLite's and Hobwork's own.
export function schemaOf(db: DatabaseSync): Map<string, SchemaObject> {
  const objects = new Map<string, SchemaObject>()
  const rows = db
    .prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'view', 'virtual')")
    .all()
  for (const row of rows) {
    const name = String(row.name)
    if (name.startsWith('sqlite_') || name === MIGRATIONS_TABLE) continue
    const columns = db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(name).map((c) => String(c.name))
    objects.set(name, { type: String(row.type), columns: new Set(columns) })
  }
  return objects
}

// Migrations must be additive so older versions keep working after a restore.
// Comparing the schema before and after catches DROP and RENAME in any form,
// and still allows rebuilding a table under the same name with the same columns.
export function removedFromSchema(before: Map<string, SchemaObject>, after: Map<string, SchemaObject>): string[] {
  const problems: string[] = []
  for (const [name, object] of before) {
    const now = after.get(name)
    const kind = object.type === 'view' ? 'View' : 'Table'
    if (!now) {
      problems.push(`${kind} ${name} was dropped or renamed`)
      continue
    }
    for (const column of object.columns) {
      if (!now.columns.has(column)) problems.push(`Column ${name}.${column} was dropped or renamed`)
    }
  }
  return problems
}
