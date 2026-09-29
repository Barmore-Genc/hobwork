import type { Host } from '../host.ts'
import { requireProject } from '../projects.ts'

// Branch handlers read Home Assistant states like any handler, but service
// calls and events need a person's approval for that branch. Agents have no
// way to grant it.
export type BranchHaApproval = { by: string; grantedAt: string }

export function getBranchHaApproval(host: Host, project: string, branch: string): BranchHaApproval | undefined {
  const row = host.db
    .prepare(
      `SELECT u.name, a.granted_at FROM branch_ha_approvals a
       JOIN projects p ON p.id = a.project_id JOIN users u ON u.id = a.user_id
       WHERE p.name = ? AND a.branch = ?`,
    )
    .get(project, branch)
  return row ? { by: String(row.name), grantedAt: String(row.granted_at) } : undefined
}

export function grantBranchHa(host: Host, project: string, branch: string, userId: number): BranchHaApproval {
  host.db
    .prepare(
      `INSERT INTO branch_ha_approvals (project_id, branch, user_id) VALUES (?, ?, ?)
       ON CONFLICT (project_id, branch) DO NOTHING`,
    )
    .run(requireProject(host, project).id, branch, userId)
  return getBranchHaApproval(host, project, branch)!
}

export function revokeBranchHa(host: Host, project: string, branch: string): boolean {
  const result = host.db
    .prepare('DELETE FROM branch_ha_approvals WHERE project_id = ? AND branch = ?')
    .run(requireProject(host, project).id, branch)
  return Number(result.changes) > 0
}
