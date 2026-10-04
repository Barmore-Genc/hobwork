import type { Host } from './host.ts'

export const MERGED_BRANCH_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export type BranchMerge = { commit: string; mergedAt: string }

export function recordBranchMerge(host: Host, projectId: number, branch: string, commit: string): void {
  host.db
    .prepare(
      `INSERT INTO branch_merges (project_id, branch, commit_sha) VALUES (?, ?, ?)
       ON CONFLICT (project_id, branch) DO UPDATE SET commit_sha = excluded.commit_sha, merged_at = excluded.merged_at`,
    )
    .run(projectId, branch, commit)
}

export function forgetBranchMerge(host: Host, projectId: number, branch: string): void {
  host.db.prepare('DELETE FROM branch_merges WHERE project_id = ? AND branch = ?').run(projectId, branch)
}

export function branchMerges(host: Host, projectId: number): Map<string, BranchMerge> {
  const rows = host.db
    .prepare('SELECT branch, commit_sha, merged_at FROM branch_merges WHERE project_id = ?')
    .all(projectId)
  return new Map(rows.map((r) => [String(r.branch), { commit: String(r.commit_sha), mergedAt: String(r.merged_at) }]))
}

export function cleanupAfter(mergedAt: string): string {
  return new Date(Date.parse(mergedAt) + MERGED_BRANCH_DAYS * DAY_MS).toISOString()
}
