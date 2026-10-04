import type { AppTarget } from '../apps/origins.ts'
import { deleteBranch, unmergedCommits } from '../branch-deletion.ts'
import { branchMerges, cleanupAfter } from '../branch-merges.ts'
import type { ProjectData } from '../data/project-data.ts'
import type { Delivery } from '../delivery.ts'
import { getBranchHaApproval, grantBranchHa, revokeBranchHa } from '../homeassistant/approvals.ts'
import type { Host } from '../host.ts'
import { HttpError, json } from '../http.ts'
import { DEFAULT_BRANCH, getProject, type Project } from '../projects.ts'
import { branchExists, listBranches } from '../repo.ts'
import { listInvocations } from '../runtime/logs.ts'
import type { Runtime } from '../runtime/runtime.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from '../workspaces.ts'
import { invocationView, type ApiRoute } from './routes.ts'

const RECENT_RUNS = 5

function projectOf(host: Host, name: string): Project {
  const project = getProject(host, name)
  if (!project) throw new HttpError(404, `There is no hob called "${name}"`)
  return project
}

async function requireBranch(host: Host, project: Project, branch: string) {
  if (branch === DEFAULT_BRANCH || !(await branchExists(host, project.name, branch).catch(() => false))) {
    throw new HttpError(404, `${project.name} has no branch called "${branch}"`)
  }
}

// Branches with their preview address, recent preview runs, whether they
// may control Home Assistant (agents change that over MCP) and when a merged
// branch is cleaned up.
export function branchRoutes(options: {
  host: Host
  runtime?: Runtime
  appOrigin?: (target: AppTarget) => string | undefined
  workspaces: WorkspaceManager<ExecWorkspaceVm>
  delivery?: Delivery
  data?: ProjectData
}): ApiRoute[] {
  const { host, runtime, appOrigin } = options
  return [
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/branches$/,
      handle: async ({ res, params }) => {
        const project = projectOf(host, params[0]!)
        const branches = (await listBranches(host, project.name)).filter((b) => b.name !== DEFAULT_BRANCH)
        const merges = branchMerges(host, project.id)
        const unmerged = await Promise.all(branches.map((b) => unmergedCommits(host, project.name, b.name)))
        json(
          res,
          200,
          branches.map((branch, i) => {
            const merge = merges.get(branch.name)
            return {
            name: branch.name,
            head: { sha: branch.sha, subject: branch.subject, updatedAt: branch.updatedAt },
            unmergedCommits: unmerged[i],
            merged:
              merge?.commit === branch.sha ? { at: merge.mergedAt, cleanupAfter: cleanupAfter(merge.mergedAt) } : null,
            previewUrl: appOrigin?.({ project: project.name, branch: branch.name }) ?? null,
            running: runtime?.previewStatus(project.name, branch.name).running ?? false,
            homeAssistant: getBranchHaApproval(host, project.name, branch.name) ?? null,
            recentRuns: listInvocations(host, { project: project.name, branch: branch.name, limit: RECENT_RUNS }).map((i) =>
              invocationView(i, false),
            ),
          }
          }),
        )
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/projects\/([^/]+)\/branches\/([^/]+)$/,
      handle: async ({ res, params }) => {
        const project = projectOf(host, params[0]!)
        const branch = params[1]!
        await requireBranch(host, project, branch)
        await deleteBranch({ ...options, runtime }, project.name, branch, { discard: true })
        res.writeHead(204).end()
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/projects\/([^/]+)\/branches\/([^/]+)\/home-assistant$/,
      handle: async ({ res, user, params }) => {
        const project = projectOf(host, params[0]!)
        await requireBranch(host, project, params[1]!)
        json(res, 200, grantBranchHa(host, project.name, params[1]!, { userId: user.id }))
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/projects\/([^/]+)\/branches\/([^/]+)\/home-assistant$/,
      handle: ({ res, params }) => {
        const project = projectOf(host, params[0]!)
        revokeBranchHa(host, project.name, params[1]!)
        res.writeHead(204).end()
      },
    },
  ]
}
