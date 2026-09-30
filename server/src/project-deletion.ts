import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { User } from './auth/users.ts'
import { projectListChanges, publishChange } from './changes.ts'
import type { ProjectData } from './data/project-data.ts'
import type { Delivery } from './delivery.ts'
import { repoPath, type Host } from './host.ts'
import { assertNameFree } from './project-rename.ts'
import { claimName, DEFAULT_BRANCH, getProject, ProjectError, requireProject, type Project } from './projects.ts'
import { projectBuildsDir } from './runtime/builds.ts'
import { appendLog } from './runtime/logs.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { StorageUsage } from './storage.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from './workspaces.ts'

// Backups may run less often than projects are deleted by mistake, so the code
// and data stay in the trash for a while.
export const TRASH_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const TRASH_INFO = 'deleted.json'

// What restoring needs besides the repo and DB. Fields after `versions` were
// added later and are missing in older entries.
export type TrashInfo = {
  project: string
  deletedAt: string
  purgeAfter: string
  deletedBy: string | null
  versions: {
    number: number
    commit: string
    summary: string
    createdAt: string
    agentId?: number | null
    userId?: number | null
    restoredFrom?: number | null
    installScripts?: { added: string[]; removed: string[] }
  }[]
  createdAt?: string
  secrets?: {
    secretId: number
    envName: string
    assignedByUserId: number | null
    assignedByAgentId: number | null
    assignedAt: string
  }[]
  webhookTokens?: { name: string; tokenHash: string; createdAt: string }[]
  nfcTags?: { id: string; createdAt: string }[]
  // Agent tokens and OAuth connections limited to a list of projects that included this one.
  access?: { tokens: number[]; grants: number[] }
  // The project's own AI models and limits, as stored. Entries from before the
  // host picked models have `models` instead of `model` and `decisionModel`.
  ai?: {
    model?: string | null
    decisionModel?: string | null
    embeddingModel?: string | null
    limits: string | null
    updatedByUserId: number | null
    updatedByAgentId?: number | null
    updatedAt: string
  } | null
}

export type TrashEntry = {
  id: string
  project: string
  deletedAt: string
  purgeAfter: string
  deletedBy: string | null
  versions: number
  lastVersion: { number: number; summary: string; createdAt: string } | null
  // Whether a project uses the name, so restoring needs another one.
  nameTaken: boolean
}

export type ProjectDeletionDeps = {
  host: Host
  workspaces: Pick<WorkspaceManager<ExecWorkspaceVm>, 'list' | 'remove'>
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
      ...restorableRows(host, project.id),
      createdAt: project.createdAt,
    }
    writeFileSync(join(trash, TRASH_INFO), `${JSON.stringify(info, null, 2)}\n`)
    renameSync(repoPath(host, name), join(trash, 'repo.git'))
    moved = true
    if (existsSync(projectDataDir(host, name))) renameSync(projectDataDir(host, name), join(trash, 'data'))
    rmSync(projectBuildsDir(host, name), { recursive: true, force: true })
    rmSync(join(host.dataDir, 'workspaces', name), { recursive: true, force: true })
    host.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id)
    deps.storage?.forget(project.id)
    publishChange(host.db, ...projectListChanges(name), { kind: 'trash' })
    return { trash, purgeAfter }
  } finally {
    runtime?.forget(name)
    if (!moved) {
      await runtime?.load(name).catch((err: unknown) => console.error(`Reloading ${name} after a failed deletion failed`, err))
    }
  }
}

// Rows that go with the project row but are needed to bring it back as it was:
// versions, secret assignments, webhook tokens (so webhook URLs keep working)
// and NFC tags (they are written on physical tags).
function restorableRows(
  host: Host,
  projectId: number,
): Pick<TrashInfo, 'versions' | 'secrets' | 'webhookTokens' | 'nfcTags' | 'access' | 'ai'> {
  const all = (sql: string) => host.db.prepare(sql).all(projectId)
  const nullable = (value: unknown) => (value === null ? null : Number(value))
  return {
    versions: all(
      `SELECT number, commit_sha, summary, created_at, agent_id, user_id, restored_from, builds_added, builds_removed
       FROM versions
       WHERE project_id = ? ORDER BY number DESC`,
    ).map((row) => ({
      number: Number(row.number),
      commit: String(row.commit_sha),
      summary: String(row.summary),
      createdAt: String(row.created_at),
      agentId: nullable(row.agent_id),
      userId: nullable(row.user_id),
      restoredFrom: nullable(row.restored_from),
      installScripts: { added: JSON.parse(String(row.builds_added)), removed: JSON.parse(String(row.builds_removed)) },
    })),
    secrets: all(
      `SELECT secret_id, env_name, assigned_by_user_id, assigned_by_agent_id, assigned_at FROM secret_assignments
       WHERE project_id = ? ORDER BY env_name`,
    ).map((row) => ({
      secretId: Number(row.secret_id),
      envName: String(row.env_name),
      assignedByUserId: nullable(row.assigned_by_user_id),
      assignedByAgentId: nullable(row.assigned_by_agent_id),
      assignedAt: String(row.assigned_at),
    })),
    webhookTokens: all('SELECT name, token_hash, created_at FROM webhook_tokens WHERE project_id = ? ORDER BY name').map(
      (row) => ({ name: String(row.name), tokenHash: String(row.token_hash), createdAt: String(row.created_at) }),
    ),
    nfcTags: all('SELECT id, created_at FROM nfc_tags WHERE project_id = ? ORDER BY id').map((row) => ({
      id: String(row.id),
      createdAt: String(row.created_at),
    })),
    access: {
      tokens: all('SELECT token_id FROM agent_token_projects WHERE project_id = ? ORDER BY token_id').map((row) => Number(row.token_id)),
      grants: all('SELECT grant_id FROM oauth_grant_projects WHERE project_id = ? ORDER BY grant_id').map((row) => Number(row.grant_id)),
    },
    ai:
      all(
        `SELECT model, decision_model, embedding_model, limits, updated_by_user_id, updated_by_agent_id, updated_at
         FROM project_ai_settings WHERE project_id = ?`,
      ).map((row) => ({
        model: row.model === null ? null : String(row.model),
        decisionModel: row.decision_model === null ? null : String(row.decision_model),
        embeddingModel: row.embedding_model === null ? null : String(row.embedding_model),
        limits: row.limits === null ? null : String(row.limits),
        updatedByUserId: nullable(row.updated_by_user_id),
        updatedByAgentId: nullable(row.updated_by_agent_id),
        updatedAt: String(row.updated_at),
      }))[0] ?? null,
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
  if (purged.length) publishChange(host.db, { kind: 'trash' })
  return purged
}

// Directory names in the trash, as deleteProject makes them.
const TRASH_ENTRY = /^[a-z0-9]+(-[a-z0-9]+)*-\d{8}T\d{6}Z(-[0-9a-f]{6})?$/

function trashEntryDir(host: Host, id: string): string | undefined {
  if (!TRASH_ENTRY.test(id)) return undefined
  const dir = join(trashDir(host), id)
  return existsSync(join(dir, 'repo.git')) ? dir : undefined
}

// Deleted projects that can still be restored, newest first.
export function listTrash(host: Host): TrashEntry[] {
  const dir = trashDir(host)
  if (!existsSync(dir)) return []
  const entries: TrashEntry[] = []
  for (const id of readdirSync(dir)) {
    const path = trashEntryDir(host, id)
    const info = path && readTrashInfo(path)
    if (!info) continue
    const last = info.versions[0]
    entries.push({
      id,
      project: info.project,
      deletedAt: info.deletedAt,
      purgeAfter: info.purgeAfter,
      deletedBy: info.deletedBy,
      versions: info.versions.length,
      lastVersion: last ? { number: last.number, summary: last.summary, createdAt: last.createdAt } : null,
      nameTaken: getProject(host, info.project) !== undefined,
    })
  }
  return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

export type ProjectRestoreDeps = {
  host: Host
  delivery?: Pick<Delivery, 'exclusive'>
  runtime?: Pick<Runtime, 'load'>
}

// Brings a deleted project back from the trash, under its old name or another
// one: its repo, DB, versions, secret assignments whose secret still exists,
// webhook tokens, NFC tags, its own AI models and limits, and its place in the
// project lists of agent tokens and OAuth connections that still exist. Run
// history, logs, AI usage records and branch workspaces stay gone. It starts like after a host restart, building its
// deployed version when first needed.
export async function restoreProject(
  deps: ProjectRestoreDeps,
  id: string,
  options: { name?: string; user?: User } = {},
): Promise<Project> {
  const dir = trashEntryDir(deps.host, id)
  const info = dir && readTrashInfo(dir)
  if (!dir || !info) throw new ProjectError('This deleted hob is no longer in the trash')
  const name = options.name ?? info.project
  const run = () => restoreNow(deps, dir, info, name, options.user)
  return deps.delivery ? deps.delivery.exclusive(name, run) : run()
}

async function restoreNow(deps: ProjectRestoreDeps, dir: string, info: TrashInfo, name: string, user?: User): Promise<Project> {
  const { host } = deps
  assertNameFree(host, name)
  if (!existsSync(join(dir, 'repo.git'))) throw new ProjectError('This deleted hob is no longer in the trash')
  const repo = repoPath(host, name)
  const data = join(host.dataDir, 'projects', name)
  // Left over from an earlier project with this name; nothing uses them.
  rmSync(projectBuildsDir(host, name), { recursive: true, force: true })
  rmSync(join(host.dataDir, 'workspaces', name), { recursive: true, force: true })

  mkdirSync(dirname(repo), { recursive: true })
  renameSync(join(dir, 'repo.git'), repo)
  const hasData = existsSync(join(dir, 'data'))
  let project: Project
  try {
    if (hasData) renameSync(join(dir, 'data'), data)
    project = insertRestored(host, name, info)
  } catch (err) {
    if (hasData && existsSync(data)) renameSync(data, join(dir, 'data'))
    renameSync(repo, join(dir, 'repo.git'))
    throw err
  }
  rmSync(dir, { recursive: true, force: true })
  publishChange(host.db, ...projectListChanges(name), { kind: 'trash' })
  const formerly = name === info.project ? '' : ` (it was called ${info.project})`
  appendLog(host, {
    project: name,
    source: 'runtime',
    level: 'info',
    event: 'project',
    message: `Restored from deleted hobs${user ? ` by ${user.name}` : ''}${formerly}`,
  })
  await deps.runtime?.load(name).catch((err: unknown) => console.error(`Loading ${name} after restoring it failed`, err))
  return project
}

function insertRestored(host: Host, name: string, info: TrashInfo): Project {
  const { db } = host
  const existing = (table: string, id: number | null | undefined) =>
    id != null && db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined ? id : null
  db.exec('BEGIN')
  try {
    const row = db
      .prepare(
        `INSERT INTO projects (name, default_branch, created_at)
         VALUES (?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) RETURNING id`,
      )
      .get(name, DEFAULT_BRANCH, info.createdAt ?? null)
    const projectId = Number(row!.id)
    claimName(host, name)
    const version = db.prepare(
      `INSERT INTO versions (project_id, number, commit_sha, summary, agent_id, user_id, restored_from,
         builds_added, builds_removed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const v of info.versions) {
      version.run(
        projectId,
        v.number,
        v.commit,
        v.summary,
        existing('agents', v.agentId),
        existing('users', v.userId),
        v.restoredFrom ?? null,
        JSON.stringify(v.installScripts?.added ?? []),
        JSON.stringify(v.installScripts?.removed ?? []),
        v.createdAt,
      )
    }
    const assign = db.prepare(
      `INSERT OR IGNORE INTO secret_assignments
         (project_id, secret_id, env_name, assigned_by_user_id, assigned_by_agent_id, assigned_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const a of info.secrets ?? []) {
      if (existing('secrets', a.secretId) === null) continue
      assign.run(
        projectId,
        a.secretId,
        a.envName,
        existing('users', a.assignedByUserId),
        existing('agents', a.assignedByAgentId),
        a.assignedAt,
      )
    }
    const token = db.prepare('INSERT OR IGNORE INTO webhook_tokens (project_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    for (const t of info.webhookTokens ?? []) token.run(projectId, t.name, t.tokenHash, t.createdAt)
    const tag = db.prepare('INSERT OR IGNORE INTO nfc_tags (id, project_id, created_at) VALUES (?, ?, ?)')
    for (const t of info.nfcTags ?? []) tag.run(t.id, projectId, t.createdAt)
    const tokenAccess = db.prepare(
      'INSERT OR IGNORE INTO agent_token_projects (token_id, project_id) SELECT id, ? FROM agent_tokens WHERE id = ?',
    )
    for (const id of info.access?.tokens ?? []) tokenAccess.run(projectId, id)
    const grantAccess = db.prepare(
      'INSERT OR IGNORE INTO oauth_grant_projects (grant_id, project_id) SELECT id, ? FROM oauth_grants WHERE id = ?',
    )
    for (const id of info.access?.grants ?? []) grantAccess.run(projectId, id)
    const ai = info.ai
    if (ai && (ai.model != null || ai.decisionModel != null || ai.embeddingModel != null || ai.limits !== null)) {
      db.prepare(
        `INSERT INTO project_ai_settings
           (project_id, model, decision_model, embedding_model, limits, updated_by_user_id, updated_by_agent_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        projectId,
        ai.model ?? null,
        ai.decisionModel ?? null,
        ai.embeddingModel ?? null,
        ai.limits,
        existing('users', ai.updatedByUserId),
        existing('agents', ai.updatedByAgentId),
        ai.updatedAt,
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return requireProject(host, name)
}
