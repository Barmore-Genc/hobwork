import type { DatabaseSync } from 'node:sqlite'

// What an agent token or OAuth connection may do. `projects: null` means every
// project, including ones created later.
export type Access = { readOnly: boolean; projects: string[] | null }

export const FULL_ACCESS: Access = { readOnly: false, projects: null }

export class AccessError extends Error {}

export function allowsProject(access: Access, project: string): boolean {
  return access.projects === null || access.projects.includes(project)
}

export function isFullAccess(access: Access): boolean {
  return !access.readOnly && access.projects === null
}

// Validates access sent by the web UI or given on the command line. Omitted
// means full access, like credentials made before access could be limited.
export function parseAccess(db: DatabaseSync, value: unknown): Access {
  if (value === undefined || value === null) return FULL_ACCESS
  if (typeof value !== 'object' || Array.isArray(value)) throw new AccessError('Send access as an object')
  const { readOnly = false, projects = null } = value as Record<string, unknown>
  if (typeof readOnly !== 'boolean') throw new AccessError('readOnly must be true or false')
  if (projects === null) return { readOnly, projects: null }
  if (!Array.isArray(projects) || !projects.every((p) => typeof p === 'string')) {
    throw new AccessError('projects must be a list of hob names, or null for every hob')
  }
  const names = [...new Set(projects as string[])]
  if (names.length === 0) throw new AccessError('Choose at least one hob')
  for (const name of names) {
    if (!db.prepare('SELECT 1 FROM projects WHERE name = ?').get(name)) {
      throw new AccessError(`Hob "${name}" does not exist`)
    }
  }
  return { readOnly, projects: names.sort() }
}

const TABLES = {
  token: { credential: 'agent_tokens', projects: 'agent_token_projects', column: 'token_id' },
  grant: { credential: 'oauth_grants', projects: 'oauth_grant_projects', column: 'grant_id' },
} as const

export type CredentialKind = keyof typeof TABLES

export function saveAccess(db: DatabaseSync, kind: CredentialKind, id: number, access: Access) {
  const t = TABLES[kind]
  db.prepare(`UPDATE ${t.credential} SET read_only = ?, all_projects = ? WHERE id = ?`).run(
    access.readOnly ? 1 : 0,
    access.projects === null ? 1 : 0,
    id,
  )
  if (access.projects === null) return
  const insert = db.prepare(
    `INSERT INTO ${t.projects} (${t.column}, project_id) SELECT ?, id FROM projects WHERE name = ?`,
  )
  for (const name of access.projects) insert.run(id, name)
}

// Every credential of a kind, keyed by ID, for listings.
export function loadAllAccess(db: DatabaseSync, kind: CredentialKind): Map<number, Access> {
  const t = TABLES[kind]
  const projects = new Map<number, string[]>()
  for (const row of db
    .prepare(`SELECT l.${t.column} AS id, p.name FROM ${t.projects} l JOIN projects p ON p.id = l.project_id ORDER BY p.name`)
    .all()) {
    const list = projects.get(Number(row.id)) ?? []
    list.push(String(row.name))
    projects.set(Number(row.id), list)
  }
  const result = new Map<number, Access>()
  for (const row of db.prepare(`SELECT id, read_only, all_projects FROM ${t.credential}`).all()) {
    const id = Number(row.id)
    result.set(id, {
      readOnly: row.read_only === 1,
      projects: row.all_projects === 1 ? null : (projects.get(id) ?? []),
    })
  }
  return result
}

export function loadAccess(db: DatabaseSync, kind: CredentialKind, id: number): Access {
  const t = TABLES[kind]
  const row = db.prepare(`SELECT read_only, all_projects FROM ${t.credential} WHERE id = ?`).get(id)
  // A credential that is gone grants nothing.
  if (!row) return { readOnly: true, projects: [] }
  const projects =
    row.all_projects === 1
      ? null
      : db
          .prepare(`SELECT p.name FROM ${t.projects} l JOIN projects p ON p.id = l.project_id WHERE l.${t.column} = ? ORDER BY p.name`)
          .all(id)
          .map((r) => String(r.name))
  return { readOnly: row.read_only === 1, projects }
}
