import type { Agent } from './agents.ts'
import type { AppTarget } from './apps/origins.ts'
import type { Delivery } from './delivery.ts'
import type { Host } from './host.ts'
import { formatMerge } from './mcp/delivery.ts'
import { truncateMiddle } from './mcp/output.ts'
import { formatInvocation, formatLines } from './mcp/runtime.ts'
import { latestRun } from './pipeline/runner.ts'
import { DEFAULT_BRANCH, ProjectError } from './projects.ts'
import { log } from './repo.ts'
import { lastLogId, listInvocations, queryLogs, waitForLogs } from './runtime/logs.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { InternalHandler } from './sandbox/sandbox.ts'
import { listVersions } from './versions.ts'
import { createWorkspaceGit, WORKSPACE_GIT_PREFIX } from './workspace-git.ts'
import { SESSION_HEADER, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

const MAX_BODY_CHARS = 64 * 1024
const MAX_WAIT_SECONDS = 30
const DEFAULT_LOG_LINES = 50
const DEFAULT_INVOCATIONS = 20

// What the CLI prints. `ok: false` makes it exit with status 1.
export type CliResult = { output: string; ok: boolean; cursor?: number }

type Context = { project: string; branch: string; agent: Agent; url: URL; request: Request }

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(400, `${name} must be a whole number`)
  return Math.min(value, max)
}

async function bodyField(request: Request, field: string): Promise<string> {
  const text = await request.text()
  if (text.length > MAX_BODY_CHARS) throw new ApiError(413, 'Request body is too large')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError(400, 'Body must be JSON')
  }
  const value = (body as Record<string, unknown> | null)?.[field]
  if (typeof value !== 'string') throw new ApiError(400, `${field} is required`)
  return value
}

// Answers the `hobwork` CLI in a workspace VM. Each VM gets a handler bound to
// its project and branch; the session token in the request names the agent.
export function createWorkspaceApi(options: {
  host: Host
  workspaces: WorkspaceManager<ExecWorkspaceVm>
  delivery: Delivery
  runtime?: Runtime
  appOrigin?: (target: AppTarget) => string | undefined
}): (workspace: { project: string; branch: string }) => InternalHandler {
  const { host, workspaces, delivery, runtime, appOrigin } = options

  async function status({ project, branch, agent }: Context): Promise<CliResult> {
    const [head] = await log(host, project, branch, 1)
    const changes = await workspaces.changes(project, branch)
    const newest = listVersions(host, project, 1)[0]
    const deployed = runtime?.status(project)
    const run = latestRun(host, project, branch)
    const branchUrl = appOrigin?.({ project, branch })
    const mainUrl = appOrigin?.({ project })
    const lines = [
      `Workspace ${project}/${branch}, working as ${agent.name}`,
      head ? `Branch ${branch} is at ${head.sha.slice(0, 10)} "${head.subject}" (${head.author}, ${head.date})` : '',
      changes.length ? `Uncommitted changes:\n${changes.map((c) => `  ${c}`).join('\n')}` : 'No uncommitted changes',
      newest
        ? `${DEFAULT_BRANCH} is at version ${newest.number} "${newest.summary.split('\n')[0]}"${
            deployed?.version !== undefined && deployed.version !== null && deployed.version !== newest.number
              ? `, version ${deployed.version} is deployed`
              : ''
          }${deployed?.running ? ', runtime running' : ''}`
        : '',
      run
        ? `Last pipeline run for ${branch}: #${run.id} ${run.status}${run.failedStep ? ` at ${run.failedStep}` : ''}, started ${run.startedAt}`
        : `No pipeline runs for ${branch} yet`,
      branchUrl && branch !== DEFAULT_BRANCH ? `App for ${branch} (committed changes): ${branchUrl}` : '',
      mainUrl ? `App for ${DEFAULT_BRANCH}: ${mainUrl}` : '',
    ]
    return { output: lines.filter(Boolean).join('\n'), ok: true }
  }

  async function commit({ project, branch, agent, request }: Context): Promise<CliResult> {
    const message = await bodyField(request, 'message')
    const sha = await workspaces.commit(project, branch, message, agent)
    return { output: sha ? `Committed ${sha}` : 'Nothing to commit', ok: true }
  }

  async function diff({ project, branch }: Context): Promise<CliResult> {
    const changes = await workspaces.diff(project, branch)
    return { output: changes ? truncateMiddle(changes) : 'No changes', ok: true }
  }

  async function merge({ project, branch, agent, request }: Context): Promise<CliResult> {
    const summary = await bodyField(request, 'summary')
    const result = formatMerge(branch, await delivery.merge({ project, branch, summary, agent }))
    const output = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    return { output, ok: result.isError !== true }
  }

  async function logs({ project, url, request }: Context): Promise<CliResult> {
    const limit = intParam(url, 'limit', DEFAULT_LOG_LINES, 1000)
    const wait = intParam(url, 'wait', 0, MAX_WAIT_SECONDS)
    const after = url.searchParams.has('after') ? intParam(url, 'after', 0, Number.MAX_SAFE_INTEGER) : undefined
    const read = () => queryLogs(host, { project, afterId: after, limit })
    let lines = read()
    if (!lines.length && after !== undefined && wait > 0) {
      await waitForLogs(project, wait * 1000, request.signal)
      lines = read()
    }
    const formatted = formatLines(lines)
    return {
      output: formatted.text,
      ok: true,
      cursor: formatted.cursor ?? after ?? lastLogId(host, project),
    }
  }

  function invocations({ project, url }: Context): CliResult {
    const limit = intParam(url, 'limit', DEFAULT_INVOCATIONS, 200)
    const found = listInvocations(host, { project, limit })
    return { output: found.length ? truncateMiddle(found.map(formatInvocation).join('\n')) : 'No invocations yet', ok: true }
  }

  const routes: Record<string, (ctx: Context) => Promise<CliResult> | CliResult> = {
    'GET /v1/workspace/status': status,
    'GET /v1/workspace/diff': diff,
    'POST /v1/workspace/commit': commit,
    'POST /v1/workspace/merge': merge,
    'GET /v1/workspace/logs': logs,
    'GET /v1/workspace/invocations': invocations,
  }

  const workspaceGit = createWorkspaceGit({ host, workspaces })
  return ({ project, branch }) => {
    const gitHandler = workspaceGit({ project, branch })
    return async (request) => {
      const url = new URL(request.url)
      if (url.pathname.startsWith(WORKSPACE_GIT_PREFIX)) return gitHandler(request)
      const route = routes[`${request.method} ${url.pathname}`]
      if (!route) return Response.json({ error: `${request.method} ${url.pathname} does not exist` }, { status: 404 })
      const agent = workspaces.sessionAgent(project, branch, request.headers.get(SESSION_HEADER) ?? '')
      if (!agent) {
        return Response.json(
          { error: 'hobwork only works in commands started over SSH or with the bash tool' },
          { status: 401 },
        )
      }
      try {
        return Response.json(await route({ project, branch, agent, url, request }))
      } catch (err) {
        if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status })
        if (err instanceof ProjectError) return Response.json({ error: err.message }, { status: 409 })
        console.error(`workspace ${project}/${branch}: ${request.method} ${url.pathname} failed`, err)
        return Response.json({ error: 'Something went wrong on the Hobwork host' }, { status: 500 })
      }
    }
  }
}
