import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAgentToken, getAgent, listAgents, revokeAgentToken } from '../agents.ts'
import type { Auth } from '../auth/auth.ts'
import type { User } from '../auth/users.ts'
import type { Delivery } from '../delivery.ts'
import type { Host } from '../host.ts'
import { HttpError, json, readJson } from '../http.ts'
import { latestRun } from '../pipeline/runner.ts'
import { getProject, listProjects, ProjectError, type Project } from '../projects.ts'
import type { Runtime } from '../runtime/runtime.ts'
import { getVersion, listVersions, type Version } from '../versions.ts'

// ready: deployed, and the runtime starts when something calls it.
export type ProjectStatus = 'ready' | 'running' | 'updating'

const MAX_AGENT_NAME = 64
const VERSION_PAGE = 100

type Route = {
  method: string
  pattern: RegExp
  handle: (ctx: { req: IncomingMessage; res: ServerResponse; user: User; params: string[] }) => Promise<void> | void
}

function versionView(version: Version) {
  return {
    number: version.number,
    summary: version.summary,
    by: version.user ?? version.agent,
    restoredFrom: version.restoredFrom,
    createdAt: version.createdAt,
  }
}

function requireProjectByName(host: Host, name: string): Project {
  const project = getProject(host, name)
  if (!project) throw new HttpError(404, `There is no project called "${name}"`)
  return project
}

function positiveInt(value: string | undefined): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'Not found')
  return n
}

export function createApiRoutes(options: { host: Host; auth: Auth; delivery: Delivery; runtime?: Runtime }) {
  const { host, auth, delivery, runtime } = options

  // The deployed version can lag behind the newest one while a deploy runs or
  // after it failed. Without a runtime (tests), the newest version counts.
  function projectState(project: Project): { status: ProjectStatus; current: Version | undefined } {
    const runtimeStatus = runtime?.status(project.name)
    const deployed = runtimeStatus?.version
    const current =
      (deployed !== null && deployed !== undefined ? getVersion(host, project.name, deployed) : undefined) ??
      listVersions(host, project.name, 1)[0]
    const status: ProjectStatus =
      latestRun(host, project.name)?.status === 'running' ? 'updating' : runtimeStatus?.running ? 'running' : 'ready'
    return { status, current }
  }

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/api\/projects$/,
      handle: ({ res }) =>
        json(
          res,
          200,
          listProjects(host).map((project) => {
            const { status, current } = projectState(project)
            return {
              name: project.name,
              defaultBranch: project.defaultBranch,
              status,
              currentVersion: current ? versionView(current) : null,
            }
          }),
        ),
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)$/,
      handle: ({ res, params }) => {
        const project = requireProjectByName(host, params[0]!)
        const { status, current } = projectState(project)
        json(res, 200, {
          name: project.name,
          createdAt: project.createdAt,
          status,
          currentVersion: current?.number ?? null,
          versions: listVersions(host, project.name, VERSION_PAGE).map(versionView),
        })
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/versions\/(\d+)\/restore$/,
      handle: async ({ res, user, params }) => {
        const project = requireProjectByName(host, params[0]!)
        try {
          const result = await delivery.restore({ project: project.name, version: positiveInt(params[1]), user })
          json(res, 200, {
            version: versionView(result.version),
            ...(result.deployError ? { deployError: result.deployError } : {}),
          })
        } catch (err) {
          if (err instanceof ProjectError) throw new HttpError(409, err.message)
          throw err
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/agents$/,
      handle: ({ res }) => json(res, 200, listAgents(host.db)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/agents$/,
      handle: async ({ req, res }) => {
        const body = (await readJson(req)) as { name?: unknown }
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (!name) throw new HttpError(400, 'Give the agent a name')
        if (name.length > MAX_AGENT_NAME) throw new HttpError(400, `Use at most ${MAX_AGENT_NAME} characters`)
        if (listAgents(host.db).some((agent) => agent.name === name)) {
          throw new HttpError(409, `An agent called "${name}" already exists`)
        }
        const { agent, token } = createAgentToken(host.db, name)
        json(res, 201, { agent, token })
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/agents\/(\d+)\/tokens$/,
      handle: ({ res, params }) => {
        const agent = getAgent(host.db, positiveInt(params[0]))
        if (!agent) throw new HttpError(404, 'This agent no longer exists')
        const { token } = createAgentToken(host.db, agent.name)
        json(res, 201, { agent, token })
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tokens\/(\d+)\/revoke$/,
      handle: ({ res, params }) => {
        if (!revokeAgentToken(host.db, positiveInt(params[0]))) {
          throw new HttpError(404, 'This key does not exist or is already revoked')
        }
        res.writeHead(204).end()
      },
    },
  ]

  // Returns false for paths it does not own, so later handlers can take them.
  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    let params: string[] | undefined
    const allowed: string[] = []
    let route: Route | undefined
    for (const candidate of routes) {
      const match = candidate.pattern.exec(pathname)
      if (!match) continue
      allowed.push(candidate.method)
      if (candidate.method === req.method) {
        route = candidate
        try {
          params = match.slice(1).map((p) => decodeURIComponent(p))
        } catch {
          json(res, 400, { error: 'Malformed path' })
          return true
        }
        break
      }
    }
    if (allowed.length === 0) return false
    if (!route || !params) {
      res.writeHead(405, { allow: allowed.join(', ') }).end()
      return true
    }
    const user = auth.requireUser(req, res)
    if (!user) return true
    try {
      await route.handle({ req, res, user, params })
    } catch (err) {
      if (err instanceof HttpError) json(res, err.status, { error: err.message })
      else {
        console.error(`${req.method} ${pathname} failed`, err)
        if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the Hobwork server' })
      }
    }
    return true
  }
}
