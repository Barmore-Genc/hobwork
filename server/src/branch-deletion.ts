import { forgetBranchMerge, MERGED_BRANCH_DAYS } from './branch-merges.ts'
import { publishChange } from './changes.ts'
import type { ProjectData } from './data/project-data.ts'
import type { Delivery } from './delivery.ts'
import { git } from './git.ts'
import { repoPath, type Host } from './host.ts'
import { DEFAULT_BRANCH, ProjectError, requireProject } from './projects.ts'
import { assertNotDefaultBranch, branchExists, branchHead, validateBranchName } from './repo.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from './workspaces.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export type BranchDeletionDeps = {
  host: Host
  workspaces: Pick<WorkspaceManager<ExecWorkspaceVm>, 'deleteBranch' | 'isCommitted' | 'get'>
  delivery?: Pick<Delivery, 'exclusive'>
  runtime?: Pick<Runtime, 'removePreview'>
  data?: Pick<ProjectData, 'closeBranch'>
}

// Commits on the branch that are not on main.
export async function unmergedCommits(host: Host, project: string, branch: string): Promise<number> {
  validateBranchName(branch)
  const out = await git([
    '--git-dir',
    repoPath(host, project),
    'rev-list',
    '--count',
    `refs/heads/${DEFAULT_BRANCH}..refs/heads/${branch}`,
  ])
  return Number(out.trim())
}

// Deletes the branch with its workspace, DB copy, preview and the access
// granted to it. Without `discard`, refuses while the branch has work that
// main does not have.
export async function deleteBranch(
  deps: BranchDeletionDeps,
  project: string,
  branch: string,
  options: { discard?: boolean } = {},
): Promise<void> {
  const { host, workspaces } = deps
  validateBranchName(branch)
  assertNotDefaultBranch(branch)
  const { id: projectId } = requireProject(host, project)
  const run = async () => {
    if (!(await branchExists(host, project, branch))) {
      throw new ProjectError(`Branch "${branch}" does not exist in ${project}`)
    }
    if (!options.discard) {
      const ahead = await unmergedCommits(host, project, branch)
      if (ahead > 0) {
        throw new ProjectError(
          `${branch} has ${ahead} ${ahead === 1 ? 'commit' : 'commits'} that ${DEFAULT_BRANCH} does not have. Merge it first, or delete it with discard_changes to throw them away`,
        )
      }
      if (!(await workspaces.isCommitted(project, branch))) {
        throw new ProjectError(
          `${branch} has uncommitted changes. Commit and merge them first, or delete it with discard_changes to throw them away`,
        )
      }
    }
    await deps.runtime?.removePreview(project, branch)
    await workspaces.deleteBranch(project, branch)
    // A query may have opened the DB copy again while the workspace stopped.
    await deps.data?.closeBranch(project, branch)
    host.db.exec('BEGIN')
    try {
      for (const table of ['branch_webhook_tokens', 'branch_ha_approvals', 'app_share_links', 'app_sessions', 'app_codes']) {
        host.db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND branch = ?`).run(projectId, branch)
      }
      forgetBranchMerge(host, projectId, branch)
      host.db.exec('COMMIT')
    } catch (err) {
      host.db.exec('ROLLBACK')
      throw err
    }
    publishChange(host.db, { kind: 'branches', project })
  }
  return deps.delivery ? deps.delivery.exclusive(project, run) : run()
}

// Deletes branches merged at least MERGED_BRANCH_DAYS ago that still point at
// the merged commit and whose workspace nobody used since.
export async function removeMergedBranches(deps: BranchDeletionDeps, now = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - MERGED_BRANCH_DAYS * DAY_MS).toISOString()
  const rows = deps.host.db
    .prepare(
      `SELECT p.id AS project_id, p.name AS project, m.branch, m.commit_sha
       FROM branch_merges m JOIN projects p ON p.id = m.project_id
       WHERE m.merged_at <= ?`,
    )
    .all(cutoff)
  const removed: string[] = []
  for (const row of rows) {
    const project = String(row.project)
    const branch = String(row.branch)
    try {
      const head = await branchHead(deps.host, project, branch)
      if (!head) {
        forgetBranchMerge(deps.host, Number(row.project_id), branch)
        continue
      }
      if (head !== String(row.commit_sha)) continue
      const workspace = deps.workspaces.get(project, branch)
      if (workspace && workspace.lastUsedAt > cutoff) continue
      await deleteBranch(deps, project, branch)
      removed.push(`${project}/${branch}`)
    } catch (err) {
      console.error(`Removing the merged branch ${project}/${branch} failed`, err)
    }
  }
  return removed
}
