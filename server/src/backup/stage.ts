import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createDbPool } from '../data/db-pool.ts'
import { git } from '../git.ts'
import { installHooks } from '../projects.ts'
import { SECRET_KEY_FILE } from '../secrets.ts'
import { HOST_KEY_FILE } from '../ssh/gateway.ts'

export const HOST_DB_FILE = 'hobwork.db'

export type StageResult = { projects: string[]; secretKey: boolean }

async function cloneRepo(repo: string, target: string) {
  await git(['clone', '--quiet', '--mirror', '--no-local', '--template=', repo, target])
  await git(['--git-dir', target, 'config', '--remove-section', 'remote.origin'])
  mkdirSync(join(target, 'hooks'), { recursive: true })
  installHooks(target)
}

// Writes what a restore needs into `staging`, laid out like a data dir:
// hobwork.db, projects/<name>/db.sqlite, repos/<name>.git, secret.key and the
// SSH host key. Builds and workspaces are left out, since the host rebuilds
// and re-clones them. Safe while the host runs: DBs are copied with
// VACUUM INTO, and repos are cloned over git's pack protocol, which sends a
// consistent set of refs and objects while pushes and merges go on.
export async function stageBackup(dataDir: string, staging: string): Promise<StageResult> {
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  const pool = createDbPool()
  async function copyDb(from: string, to: string) {
    mkdirSync(join(to, '..'), { recursive: true })
    try {
      await pool.copy(from, to)
    } finally {
      await pool.close(from)
    }
  }

  try {
    const hostDb = join(dataDir, HOST_DB_FILE)
    if (!existsSync(hostDb)) throw new Error(`There is no host DB at ${hostDb}`)
    await copyDb(hostDb, join(staging, HOST_DB_FILE))

    // Projects come from the copy, so a project created after it was taken is
    // left out as a whole instead of being half in the backup.
    const snapshot = new DatabaseSync(join(staging, HOST_DB_FILE), { readOnly: true })
    let projects: string[]
    try {
      projects = snapshot.prepare('SELECT name FROM projects ORDER BY name').all().map((row) => String(row.name))
    } finally {
      snapshot.close()
    }

    for (const project of projects) {
      const repo = join(dataDir, 'repos', `${project}.git`)
      const db = join(dataDir, 'projects', project, 'db.sqlite')
      try {
        if (existsSync(repo)) await cloneRepo(repo, join(staging, 'repos', `${project}.git`))
        if (existsSync(db)) await copyDb(db, join(staging, 'projects', project, 'db.sqlite'))
      } catch (err) {
        // Deleted while the backup ran.
        if (!existsSync(repo) && !existsSync(db)) continue
        throw err
      }
    }

    let secretKey = false
    for (const file of [SECRET_KEY_FILE, HOST_KEY_FILE]) {
      const from = join(dataDir, file)
      if (!existsSync(from)) continue
      copyFileSync(from, join(staging, file))
      chmodSync(join(staging, file), 0o600)
      if (file === SECRET_KEY_FILE) secretKey = true
    }
    return { projects, secretKey }
  } finally {
    await pool.closeAll()
  }
}
