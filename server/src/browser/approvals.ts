import { publishChange } from '../changes.ts'
import type { Host } from '../host.ts'
import { requireProject } from '../projects.ts'

// Preview handlers open pages like the deployed version does, but only when
// someone allowed it for that branch: a work in progress can log into a real
// account and submit things, and that should not happen by accident.
export type BranchBrowserApproval = { by: string; byAgent: boolean; grantedAt: string }

export type Granter = { userId: number } | { agentId: number }

export function getBranchBrowserApproval(host: Host, project: string, branch: string): BranchBrowserApproval | undefined {
  const row = host.db
    .prepare(
      `SELECT u.name AS user_name, g.name AS agent_name, a.granted_at FROM branch_browser_approvals a
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

export function grantBranchBrowser(host: Host, project: string, branch: string, granter: Granter): BranchBrowserApproval {
  host.db
    .prepare(
      `INSERT INTO branch_browser_approvals (project_id, branch, user_id, agent_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, branch) DO NOTHING`,
    )
    .run(
      requireProject(host, project).id,
      branch,
      'userId' in granter ? granter.userId : null,
      'agentId' in granter ? granter.agentId : null,
    )
  publishChange(host.db, { kind: 'branches', project })
  return getBranchBrowserApproval(host, project, branch)!
}

export function revokeBranchBrowser(host: Host, project: string, branch: string): boolean {
  const result = host.db
    .prepare('DELETE FROM branch_browser_approvals WHERE project_id = ? AND branch = ?')
    .run(requireProject(host, project).id, branch)
  if (Number(result.changes) > 0) publishChange(host.db, { kind: 'branches', project })
  return Number(result.changes) > 0
}
