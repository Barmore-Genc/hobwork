import { publishChange } from './changes.ts'
import type { Host } from './host.ts'

export type Version = {
  number: number
  commit: string
  summary: string
  agent: string | null
  // Set when a person restored this version from the web UI.
  user: string | null
  pipelineRunId: number | null
  restoredFrom: number | null
  createdAt: string
}

const SELECT = `SELECT v.number, v.commit_sha, v.summary, a.name AS agent, u.name AS user, v.pipeline_run_id, v.restored_from,
    v.created_at
  FROM versions v JOIN projects p ON p.id = v.project_id LEFT JOIN agents a ON a.id = v.agent_id
  LEFT JOIN users u ON u.id = v.user_id`

function nullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value)
}

function toVersion(row: Record<string, unknown>): Version {
  return {
    number: Number(row.number),
    commit: String(row.commit_sha),
    summary: String(row.summary),
    agent: row.agent === null ? null : String(row.agent),
    user: row.user === null ? null : String(row.user),
    pipelineRunId: nullableNumber(row.pipeline_run_id),
    restoredFrom: nullableNumber(row.restored_from),
    createdAt: String(row.created_at),
  }
}

// Callers serialize writes to main per project, so numbering cannot race.
export function recordVersion(
  host: Host,
  version: {
    projectId: number
    commit: string
    summary: string
    agentId?: number
    userId?: number
    pipelineRunId?: number
    restoredFrom?: number
  },
): Version {
  const row = host.db
    .prepare(
      `INSERT INTO versions (project_id, number, commit_sha, summary, agent_id, user_id, pipeline_run_id, restored_from)
       VALUES (?, (SELECT coalesce(max(number), 0) + 1 FROM versions WHERE project_id = ?), ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      version.projectId,
      version.projectId,
      version.commit,
      version.summary,
      version.agentId ?? null,
      version.userId ?? null,
      version.pipelineRunId ?? null,
      version.restoredFrom ?? null,
    )
  if (!row) throw new Error('Version insert returned no row')
  const created = host.db.prepare(`${SELECT} WHERE v.id = ?`).get(Number(row.id))
  if (!created) throw new Error('Version missing after insert')
  const project = host.db.prepare('SELECT name FROM projects WHERE id = ?').get(version.projectId)
  if (project) publishChange(host.db, { kind: 'project', project: String(project.name) })
  return toVersion(created)
}

export function listVersions(host: Host, project: string, limit = 50): Version[] {
  return host.db
    .prepare(`${SELECT} WHERE p.name = ? ORDER BY v.number DESC LIMIT ?`)
    .all(project, limit)
    .map(toVersion)
}

export function getVersion(host: Host, project: string, number: number): Version | undefined {
  const row = host.db.prepare(`${SELECT} WHERE p.name = ? AND v.number = ?`).get(project, number)
  return row ? toVersion(row) : undefined
}
