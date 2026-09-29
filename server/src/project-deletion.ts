import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { User } from './auth/users.ts'
import type { ProjectData } from './data/project-data.ts'
import type { Delivery } from './delivery.ts'
import { repoPath, type Host } from './host.ts'
import { requireProject } from './projects.ts'
import { projectBuildsDir } from './runtime/builds.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { StorageUsage } from './storage.ts'
import { listVersions } from './versions.ts'
import type { WorkspaceManager, WorkspaceVm } from './workspaces.ts'

// Backups may run less often than projects are deleted by mistake, so the code
// and data stay in the trash for a while.
export const TRASH_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const TRASH_INFO = 'deleted.json'

export type TrashInfo = {
  project: string
  deletedAt: string
  purgeAfter: string
  deletedBy: string | null
  versions: { number: number; commit: string; summary: string; createdAt: string }[]
}

export type ProjectDeletionDeps = {
  host: Host
  workspaces: Pick<WorkspaceManager<WorkspaceVm>, 'list' | 'remove'>
  delivery?: Pick<Delivery, 'exclusive'>
  runtime?: Pick<Runtime, 'remove' | 'forget' | 'load'>
  data?: Pick<ProjectData, 'closeProject' | 'closeBranch'>
  storage?: Pick<StorageUsage, 'forget'>
  now?: () => number
}

export function trashDir(host: Host): string {
  return join(host.dataDir, 'trash')
}

function projectDataDir(host: Host, project: string): string {
  return join(host.dataDir, 'projects', project)
}

function compactTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

// Stops everything the project runs, moves its repo and DB to the trash and
// removes the rest: workspaces, builds, and its rows in the host DB (versions,
// pipeline runs, invocations, logs, webhook tokens, secrets and the like go
// with the project row). The name can be used again right away.
export async function deleteProject(
  deps: ProjectDeletionDeps,
  name: string,
  by: { user?: User } = {},
): Promise<{ trash: string; purgeAfter: string }> {
  const run = () => deleteNow(deps, name, by)
  return deps.delivery ? deps.delivery.exclusive(name, run) : run()
}

async function deleteNow(
  deps: ProjectDeletionDeps,
  name: string,
  by: { user?: User },
): Promise<{ trash: string; purgeAfter: string }> {
  const { host, runtime, data } = deps
  const project = requireProject(host, name)
  const now = deps.now?.() ?? Date.now()
  let moved = false
  try {
    await runtime?.remove(name)
    for (const workspace of deps.workspaces.list(name)) {
      await deps.workspaces.remove(name, workspace.branch)
      await data?.closeBranch(name, workspace.branch)
    }
    await data?.closeProject(name)

    let trash = join(trashDir(host), `${name}-${compactTime(now)}`)
    if (existsSync(trash)) trash += `-${randomBytes(3).toString('hex')}`
    mkdirSync(trash, { recursive: true })
    const purgeAfter = new Date(now + TRASH_DAYS * DAY_MS).toISOString()
    const info: TrashInfo = {
      project: name,
      deletedAt: new Date(now).toISOString(),
      purgeAfter,
      deletedBy: by.user ? (by.user.email ?? by.user.name) : null,
      versions: listVersions(host, name, Number.MAX_SAFE_INTEGER).map(({ number, commit, summary, createdAt }) => ({
        number,
        commit,
        summary,
        createdAt,
      })),
    }
    writeFileSync(join(trash, TRASH_INFO), `${JSON.stringify(info, null, 2)}\n`)
    renameSync(repoPath(host, name), join(trash, 'repo.git'))
    moved = true
    if (existsSync(projectDataDir(host, name))) renameSync(projectDataDir(host, name), join(trash, 'data'))
    rmSync(projectBuildsDir(host, name), { recursive: true, force: true })
    rmSync(join(host.dataDir, 'workspaces', name), { recursive: true, force: true })
    host.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id)
    deps.storage?.forget(project.id)
    return { trash, purgeAfter }
  } finally {
    runtime?.forget(name)
    if (!moved) {
      await runtime?.load(name).catch((err: unknown) => console.error(`Reloading ${name} after a failed deletion failed`, err))
    }
  }
}

function readTrashInfo(dir: string): TrashInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, TRASH_INFO), 'utf8')) as TrashInfo
  } catch {
    return undefined
  }
}

// Removes deleted projects whose time in the trash is over. Returns their
// directory names.
export function purgeTrash(host: Host, now = Date.now()): string[] {
  const dir = trashDir(host)
  if (!existsSync(dir)) return []
  const purged: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const purgeAfter = readTrashInfo(path)?.purgeAfter
    let due: number
    try {
      due = purgeAfter ? Date.parse(purgeAfter) : statSync(path).mtimeMs + TRASH_DAYS * DAY_MS
    } catch {
      continue
    }
    if (Number.isNaN(due) || now < due) continue
    rmSync(path, { recursive: true, force: true })
    purged.push(entry)
  }
  return purged
}
