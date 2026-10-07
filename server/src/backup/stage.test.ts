import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDb, openHostDb } from '../db.ts'
import { git } from '../git.ts'
import { repoPath, type Host } from '../host.ts'
import { createProject } from '../projects.ts'
import { loadSecretKey } from '../secrets.ts'
import { stageBackup } from './stage.ts'

let dataDir: string
let host: Host
let staging: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hobwork-stage-'))
  host = { db: openHostDb(join(dataDir, 'hobwork.db')), dataDir }
  staging = join(dataDir, 'backup-staging')
})

afterEach(() => {
  host.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function projectDb(project: string): DatabaseSync {
  const db = openDb(join(dataDir, 'projects', project, 'db.sqlite'))
  db.exec('CREATE TABLE IF NOT EXISTS pairs (n INTEGER NOT NULL) STRICT')
  return db
}

async function refs(gitDir: string): Promise<string> {
  return git(['--git-dir', gitDir, 'for-each-ref', '--format=%(refname) %(objectname)'])
}

test('stages the host DB, project DBs, repos and keys, and leaves out what the host recreates', async () => {
  await createProject(host, 'filament')
  await createProject(host, 'alarms')
  const repo = repoPath(host, 'filament')
  const main = (await git(['--git-dir', repo, 'rev-parse', 'main'])).trim()
  await git(['--git-dir', repo, 'update-ref', 'refs/heads/add-spools', main])
  const db = projectDb('filament')
  db.exec('INSERT INTO pairs VALUES (1), (2)')
  db.close()
  loadSecretKey(dataDir)
  writeFileSync(join(dataDir, 'ssh_host_ed25519_key'), 'host key', { mode: 0o600 })
  mkdirSync(join(dataDir, 'builds', 'filament', 'abc'), { recursive: true })
  mkdirSync(join(dataDir, 'workspaces', 'filament', 'add-spools'), { recursive: true })
  mkdirSync(join(dataDir, 'projects', 'filament', 'files', 'photos'), { recursive: true })
  writeFileSync(join(dataDir, 'projects', 'filament', 'files', 'photos', 'cat.jpg'), 'meow')
  mkdirSync(join(dataDir, 'projects', 'filament', 'files.tmp'), { recursive: true })
  writeFileSync(join(dataDir, 'projects', 'filament', 'files.tmp', 'upload'), 'half')

  const result = await stageBackup(dataDir, staging)
  expect(result).toEqual({ projects: ['alarms', 'filament'], secretKey: true })

  const staged = new DatabaseSync(join(staging, 'hobwork.db'), { readOnly: true })
  expect(staged.prepare('SELECT name FROM projects ORDER BY name').all().map((r) => r.name)).toEqual(['alarms', 'filament'])
  staged.close()
  const stagedProject = new DatabaseSync(join(staging, 'projects', 'filament', 'db.sqlite'), { readOnly: true })
  expect(stagedProject.prepare('SELECT count(*) AS n FROM pairs').get()).toEqual({ n: 2 })
  stagedProject.close()
  expect(existsSync(join(staging, 'projects', 'alarms'))).toBe(false)
  // Files are hard links: replacing a file renames a new one into place, so the staged one stays as it was.
  const stagedFile = join(staging, 'projects', 'filament', 'files', 'photos', 'cat.jpg')
  expect(readFileSync(stagedFile, 'utf8')).toBe('meow')
  expect(statSync(stagedFile).ino).toBe(statSync(join(dataDir, 'projects', 'filament', 'files', 'photos', 'cat.jpg')).ino)
  expect(existsSync(join(staging, 'projects', 'filament', 'files.tmp'))).toBe(false)

  const stagedRepo = join(staging, 'repos', 'filament.git')
  expect(await refs(stagedRepo)).toBe(await refs(repo))
  expect((await git(['--git-dir', stagedRepo, 'symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/main')
  await git(['--git-dir', stagedRepo, 'fsck', '--strict'])
  expect(readFileSync(join(stagedRepo, 'config'), 'utf8')).not.toContain('remote')
  expect(statSync(join(stagedRepo, 'hooks', 'pre-receive')).mode & 0o111).not.toBe(0)
  expect(existsSync(join(staging, 'repos', 'alarms.git'))).toBe(true)

  expect(readFileSync(join(staging, 'secret.key'), 'utf8')).toBe(readFileSync(join(dataDir, 'secret.key'), 'utf8'))
  expect(statSync(join(staging, 'secret.key')).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(staging, 'ssh_host_ed25519_key'), 'utf8')).toBe('host key')
  expect(existsSync(join(staging, 'builds'))).toBe(false)
  expect(existsSync(join(staging, 'workspaces'))).toBe(false)
})

test('DB copies are consistent while writes go on', async () => {
  await createProject(host, 'filament')
  const db = projectDb('filament')
  let stop = false
  let batches = 0
  // Each transaction adds two rows, so a torn copy would have an odd count.
  const writer = (async () => {
    while (!stop) {
      db.exec('BEGIN; INSERT INTO pairs VALUES (1); INSERT INTO pairs VALUES (2); COMMIT')
      host.db.prepare("INSERT INTO agents (name) VALUES (?)").run(`agent-${batches}`)
      batches++
      await setImmediate()
    }
  })()
  await setImmediate()
  try {
    await stageBackup(dataDir, staging)
  } finally {
    stop = true
    await writer
    db.close()
  }

  const copy = new DatabaseSync(join(staging, 'projects', 'filament', 'db.sqlite'), { readOnly: true })
  const { n } = copy.prepare('SELECT count(*) AS n FROM pairs').get() as { n: number }
  expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  copy.close()
  expect(n % 2).toBe(0)
  expect(n).toBeGreaterThan(0)
  expect(n).toBeLessThanOrEqual(batches * 2)
  const hostCopy = new DatabaseSync(join(staging, 'hobwork.db'), { readOnly: true })
  expect(hostCopy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  hostCopy.close()
})

test('starts from an empty staging dir and skips projects whose files are gone', async () => {
  await createProject(host, 'filament')
  rmSync(repoPath(host, 'filament'), { recursive: true })
  mkdirSync(staging)
  writeFileSync(join(staging, 'leftover'), '')

  expect(await stageBackup(dataDir, staging)).toEqual({ projects: ['filament'], secretKey: false })
  expect(existsSync(join(staging, 'leftover'))).toBe(false)
  expect(existsSync(join(staging, 'repos'))).toBe(false)
})
