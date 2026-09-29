import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { User } from './auth/users.ts'
import { projectListChanges, publishChange } from './changes.ts'
import type { ProjectData } from './data/project-data.ts'
import type { Delivery } from './delivery.ts'
import { repoPath, type Host } from './host.ts'
import { claimName, getProject, ProjectError, requireProject, validateProjectName, type Project } from './projects.ts'
import { projectBuildsDir } from './runtime/builds.ts'
import { appendLog } from './runtime/logs.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { StorageUsage } from './storage.ts'
import type { WorkspaceManager, WorkspaceVm } from './workspaces.ts'

export type ProjectRenameDeps = {
  host: Host
  workspaces: Pick<WorkspaceManager<WorkspaceVm>, 'list' | 'stop' | 'relink'>
  delivery?: Pick<Delivery, 'exclusive'>
  runtime?: Pick<Runtime, 'remove' | 'forget' | 'load'>
  data?: Pick<ProjectData, 'closeProject' | 'closeBranch'>
  storage?: Pick<StorageUsage, 'measure'>
}

// Everything on disk that is named after the project.
export function projectPaths(host: Host, name: string): string[] {
  return [
    repoPath(host, name),
    join(host.dataDir, 'projects', name),
    projectBuildsDir(host, name),
    join(host.dataDir, 'workspaces', name),
  ]
}

// Refuses a name that is invalid, taken, or still has files on disk.
export function assertNameFree(host: Host, name: string): void {
  validateProjectName(name)
  if (getProject(host, name)) throw new ProjectError(`There is already a hob called "${name}"`)
  if (existsSync(repoPath(host, name)) || existsSync(join(host.dataDir, 'projects', name))) {
    throw new ProjectError(`Hobwork still has files of a hob called "${name}". Pick another name`)
  }
}

// Moves the project to a new name: its repo, DB, builds and branch workspaces
// with their DB copies. Everything it runs stops first, running handlers and
// workspace commands included, and starts again under the new name when next
// needed. Rows in the host DB reference the project by ID, so only its name
// changes. The old name stays an alias for webhooks and app links.
export async function renameProject(
  deps: ProjectRenameDeps,
  from: string,
  to: string,
  by: { user?: User } = {},
): Promise<Project> {
  const run = () => renameNow(deps, from, to, by)
  return deps.delivery ? deps.delivery.exclusive(from, run) : run()
}

async function renameNow(deps: ProjectRenameDeps, from: string, to: string, by: { user?: User }): Promise<Project> {
  const { host, runtime, data, workspaces } = deps
  const project = requireProject(host, from)
  if (to === from) throw new ProjectError(`The hob is already called "${to}"`)
  assertNameFree(host, to)

  const branches = workspaces.list(from).map((w) => w.branch)
  const moved: [string, string][] = []
  let renamed = false
  try {
    await runtime?.remove(from)
    for (const branch of branches) {
      await workspaces.stop(from, branch)
      await data?.closeBranch(from, branch)
    }
    await data?.closeProject(from)

    const targets = projectPaths(host, to)
    projectPaths(host, from).forEach((path, i) => {
      if (!existsSync(path)) return
      const target = targets[i]!
      if (existsSync(target)) throw new ProjectError(`Hobwork still has files at ${target}. Pick another name`)
      mkdirSync(dirname(target), { recursive: true })
      renameSync(path, target)
      moved.push([path, target])
    })

    host.db.exec('BEGIN')
    try {
      host.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(to, project.id)
      claimName(host, to)
      host.db
        .prepare(
          `INSERT INTO project_renames (name, project_id) VALUES (?, ?)
           ON CONFLICT (name) DO UPDATE SET project_id = excluded.project_id, renamed_at = excluded.renamed_at`,
        )
        .run(from, project.id)
      host.db.exec('COMMIT')
    } catch (err) {
      host.db.exec('ROLLBACK')
      throw err
    }
    renamed = true
    publishChange(host.db, ...projectListChanges(from, to))
  } catch (err) {
    for (const [path, target] of moved.reverse()) {
      try {
        renameSync(target, path)
      } catch (undo) {
        console.error(`Moving ${target} back to ${path} after a failed rename failed`, undo)
      }
    }
    throw err
  } finally {
    runtime?.forget(from)
    const current = renamed ? to : from
    await runtime?.load(current).catch((err: unknown) => console.error(`Loading ${current} after a rename failed`, err))
  }

  for (const branch of branches) {
    // A command may have started a workspace VM on the old paths while the
    // project was stopping.
    await workspaces.stop(to, branch)
    await workspaces
      .relink(to, branch)
      .catch((err: unknown) => console.error(`Pointing workspace ${to}/${branch} at the renamed repo failed`, err))
  }
  // A measurement that was running on the old paths finds them gone.
  void deps.storage?.measure({ id: project.id, name: to })
  appendLog(host, {
    project: to,
    source: 'runtime',
    level: 'info',
    event: 'project',
    message: `Renamed from ${from} to ${to}${by.user ? ` by ${by.user.name}` : ''}`,
  })
  return requireProject(host, to)
}
