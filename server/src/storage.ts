import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { repoPath, type Host } from './host.ts'
import type { Project } from './projects.ts'
import { projectBuildsDir } from './runtime/builds.ts'

// Bytes on disk per part of a project. `logs` counts the text of its log lines
// and invocation errors in the host DB, since they share one file with every
// other project.
export type StorageUse = {
  total: number
  database: number
  branchDatabases: number
  workspaces: number
  repo: number
  builds: number
  logs: number
  measuredAt: string
}

export const STORAGE_MAX_AGE_MS = 5 * 60 * 1000

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await lstat(path)).size
  } catch {
    return 0
  }
}

// Symlinks are not followed: project code can write them into checkouts.
async function dirSize(dir: string): Promise<number> {
  let size = 0
  for (const entry of await entries(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) size += await dirSize(path)
    else if (entry.isFile()) size += await fileSize(path)
  }
  return size
}

const isDbFile = (name: string) => name === 'db.sqlite' || name.startsWith('db.sqlite-')

async function workspaceSizes(host: Host, project: string) {
  let branchDatabases = 0
  let workspaces = 0
  const root = join(host.dataDir, 'workspaces', project)
  for (const branch of await entries(root)) {
    if (!branch.isDirectory()) continue
    for (const entry of await entries(join(root, branch.name))) {
      const path = join(root, branch.name, entry.name)
      if (entry.isDirectory()) workspaces += await dirSize(path)
      else if (entry.isFile() && isDbFile(entry.name)) branchDatabases += await fileSize(path)
      else if (entry.isFile()) workspaces += await fileSize(path)
    }
  }
  return { branchDatabases, workspaces }
}

function logSize(host: Host, projectId: number): number {
  const row = host.db
    .prepare(
      `SELECT
         (SELECT coalesce(sum(octet_length(message)), 0) FROM logs WHERE project_id = ?)
         + (SELECT coalesce(sum(coalesce(octet_length(error), 0) + coalesce(octet_length(stack), 0)), 0)
            FROM invocations WHERE project_id = ?) AS size`,
    )
    .get(projectId, projectId)
  return Number(row?.size ?? 0)
}

export async function measureStorage(host: Host, project: Pick<Project, 'id' | 'name'>, now = new Date()): Promise<StorageUse> {
  const [database, repo, builds, { branchDatabases, workspaces }] = await Promise.all([
    dirSize(join(host.dataDir, 'projects', project.name)),
    dirSize(repoPath(host, project.name)),
    dirSize(projectBuildsDir(host, project.name)),
    workspaceSizes(host, project.name),
  ])
  const logs = logSize(host, project.id)
  return {
    total: database + branchDatabases + workspaces + repo + builds + logs,
    database,
    branchDatabases,
    workspaces,
    repo,
    builds,
    logs,
    measuredAt: now.toISOString(),
  }
}

// Walking a project's directories takes too long to do on every request, so
// requests get the last measurement and stale ones are measured again in the
// background, one project at a time. Entries are keyed by project ID, so a
// renamed project keeps its numbers until the next measurement.
export function createStorageUsage(host: Host, options: { maxAgeMs?: number; now?: () => number } = {}) {
  const maxAgeMs = options.maxAgeMs ?? STORAGE_MAX_AGE_MS
  const now = options.now ?? Date.now
  const cache = new Map<number, StorageUse>()
  const queued = new Map<number, Pick<Project, 'id' | 'name'>>()
  let running: Promise<void> | undefined

  async function drain() {
    try {
      for (let next = queued.values().next(); !next.done; next = queued.values().next()) {
        const project = next.value
        queued.delete(project.id)
        try {
          cache.set(project.id, await measureStorage(host, project, new Date(now())))
        } catch (err) {
          console.error(`Measuring the storage of ${project.name} failed`, err)
        }
      }
    } finally {
      running = undefined
    }
  }

  function measure(project: Pick<Project, 'id' | 'name'>): Promise<void> {
    queued.set(project.id, { id: project.id, name: project.name })
    running ??= drain()
    return running
  }

  return {
    get(project: Pick<Project, 'id' | 'name'>): StorageUse | null {
      const use = cache.get(project.id)
      if (!use || now() - Date.parse(use.measuredAt) >= maxAgeMs) void measure(project)
      return use ?? null
    },

    measure,

    measureAll(projects: Pick<Project, 'id' | 'name'>[]): Promise<void> {
      const ids = new Set(projects.map((p) => p.id))
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id)
      for (const project of projects) void measure(project)
      return running ?? Promise.resolve()
    },

    // For a project that is gone or renamed, so nothing shows old numbers.
    forget(projectId: number) {
      cache.delete(projectId)
      queued.delete(projectId)
    },
  }
}

export type StorageUsage = ReturnType<typeof createStorageUsage>
