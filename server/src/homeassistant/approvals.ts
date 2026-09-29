import { publishChange } from '../changes.ts'
import type { Host } from '../host.ts'
import { requireProject } from '../projects.ts'

// Branch handlers read Home Assistant states like any handler, but service
// calls and events need someone to allow it for that branch, so work in
// progress does not switch real devices by accident. A person or an agent can.
export type BranchHaApproval = { by: string; byAgent: boolean; grantedAt: string }

export type Granter = { userId: number } | { agentId: number }

export function getBranchHaApproval(host: Host, project: string, branch: string): BranchHaApproval | undefined {
  const row = host.db
    .prepare(
      `SELECT u.name AS user_name, g.name AS agent_name, a.granted_at FROM branch_ha_approvals a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN agents g ON g.id = a.agent_id
       WHERE p.name = ? AND a.branch = ?`,
    )
    .get(project, branch)
  if (!row) return undefined
  const byAgent = row.agent_name !== null
  return { by: String(byAgent ? row.agent_name : row.user_name), byAgent, grantedAt: String(row.granted_at) }
}

export function grantBranchHa(host: Host, project: string, branch: string, granter: Granter): BranchHaApproval {
  host.db
    .prepare(
      `INSERT INTO branch_ha_approvals (project_id, branch, user_id, agent_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, branch) DO NOTHING`,
    )
    .run(
      requireProject(host, project).id,
      branch,
      'userId' in granter ? granter.userId : null,
      'agentId' in granter ? granter.agentId : null,
    )
  publishChange(host.db, { kind: 'branches', project })
  return getBranchHaApproval(host, project, branch)!
}

export function revokeBranchHa(host: Host, project: string, branch: string): boolean {
  const result = host.db
    .prepare('DELETE FROM branch_ha_approvals WHERE project_id = ? AND branch = ?')
    .run(requireProject(host, project).id, branch)
  if (Number(result.changes) > 0) publishChange(host.db, { kind: 'branches', project })
  return Number(result.changes) > 0
}
