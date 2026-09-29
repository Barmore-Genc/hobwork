import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createAgentToken, getAgent, listAgents, MAX_AGENT_NAME, revokeAgentToken } from '../agents.ts'
import type { Auth } from '../auth/auth.ts'
import type { User } from '../auth/users.ts'
import type { Delivery } from '../delivery.ts'
import type { Host } from '../host.ts'
import { HttpError, json, readJson } from '../http.ts'
import { listConnections, revokeGrant } from '../oauth/grants.ts'
import { latestRun } from '../pipeline/runner.ts'
import { getProject, listProjects, ProjectError, type Project } from '../projects.ts'
import type { ProjectData } from '../data/project-data.ts'
import { readProjectConfig, type ProjectConfig } from '../runtime/config.ts'
import { nextRun, parseCron } from '../runtime/cron.ts'
import {
  getInvocation,
  lastLogId,
  latestInvocations,
  listInvocations,
  queryLogs,
  waitForLogs,
  type InvocationKind,
  type InvocationRecord,
  type InvocationStatus,
  type LogFilter,
} from '../runtime/logs.ts'
import type { Runtime } from '../runtime/runtime.ts'
import { rotateWebhookToken, webhookPath, webhookTokenCreatedAt } from '../runtime/webhooks.ts'
import { SecretError, type SecretStore } from '../secrets.ts'
import { addSshKey, deleteSshKey, listSshKeys, SshKeyError } from '../ssh/keys.ts'
import { getVersion, listVersions, type Version } from '../versions.ts'

// ready: deployed, and the runtime starts when something calls it.
export type ProjectStatus = 'ready' | 'running' | 'updating'

const VERSION_PAGE = 100
const INVOCATION_PAGE = 50
const MAX_INVOCATION_PAGE = 200
// An invocation keeps at most 1,000 lines plus the one saying the rest was dropped.
const INVOCATION_LOG_LINES = 1001
const LOG_PAGE = 200
const MAX_LOG_PAGE = 1000
const LOG_WAIT_MS = 25_000
const LIST_ERROR_CHARS = 300

const INVOCATION_KINDS: InvocationKind[] = ['route', 'webhook', 'cron', 'trigger']
const INVOCATION_STATUSES: InvocationStatus[] = ['running', 'ok', 'error']
const LOG_VIEWS = ['all', 'events', 'problems'] as const

type Route = {
  method: string
  pattern: RegExp
  handle: (ctx: {
    req: IncomingMessage
    res: ServerResponse
    user: User
    params: string[]
    query: URLSearchParams
  }) => Promise<void> | void
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

function queryInt(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, `${name} must be a whole number`)
  return n
}

function pageSize(query: URLSearchParams, fallback: number, max: number): number {
  return Math.min(Math.max(queryInt(query, 'limit') ?? fallback, 1), max)
}

function queryEnum<T extends string>(query: URLSearchParams, name: string, values: readonly T[]): T | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  if (!values.includes(raw as T)) throw new HttpError(400, `${name} must be one of ${values.join(', ')}`)
  return raw as T
}

function queryTime(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  const time = Date.parse(raw)
  if (Number.isNaN(time)) throw new HttpError(400, `${name} must be a date and time`)
  return new Date(time).toISOString()
}

function invocationView(invocation: InvocationRecord, full: boolean) {
  const { stack, error, ...rest } = invocation
  if (full) return { ...rest, error, stack }
  return { ...rest, error: error && error.length > LIST_ERROR_CHARS ? `${error.slice(0, LIST_ERROR_CHARS)}…` : error }
}

function nextCronRun(schedule: string): string | null {
  try {
    return nextRun(parseCron(schedule), new Date())?.toISOString() ?? null
  } catch {
    return null
  }
}

export function createApiRoutes(options: {
  host: Host
  auth: Auth
  delivery: Delivery
  publicUrl: string
  runtime?: Runtime
  data?: ProjectData
  secrets?: SecretStore
}) {
  const { host, auth, delivery, runtime } = options

  // What the deployed version declares. Without a runtime (tests), the newest version's.
  async function deployedConfig(project: string): Promise<ProjectConfig | undefined> {
    if (runtime) return (await runtime.config(project)).config
    const [latest] = listVersions(host, project, 1)
    return latest && readProjectConfig(host, project, latest.commit)
  }

  // True when the deployed version has a UI, or has not been built yet.
  async function hasApp(project: string): Promise<boolean> {
    if (!runtime) return false
    const build = await runtime.storedBuild(project)
    return build === undefined || existsSync(join(build, 'index.html'))
  }

  async function projectDetail(project: Project) {
    let config: ProjectConfig | undefined
    let configError: string | undefined
    try {
      config = await deployedConfig(project.name)
    } catch (err) {
      if (!(err instanceof ProjectError)) throw err
      configError = err.message
    }
    const latest = latestInvocations(host, project.name)
    const lastRun = (kind: InvocationKind, name: string) => {
      const invocation = latest.get(`${kind} ${name}`)
      return invocation ? { id: invocation.id, status: invocation.status, startedAt: invocation.startedAt } : null
    }
    const entryPoints = config && {
      routes: Object.keys(config.routes).map((key) => ({ key, lastRun: lastRun('route', key) })),
      crons: Object.entries(config.crons).map(([name, { schedule }]) => ({
        name,
        schedule,
        nextRun: nextCronRun(schedule),
        lastRun: lastRun('cron', name),
      })),
      webhooks: Object.keys(config.webhooks).map((name) => ({
        name,
        tokenCreatedAt: webhookTokenCreatedAt(host, project.name, name) ?? null,
        lastRun: lastRun('webhook', name),
      })),
      triggers: Object.entries(config.triggers).map(([name, entry]) => ({
        name,
        homeassistant: entry.homeassistant ?? null,
        lastRun: lastRun('trigger', name),
      })),
    }
    const secretHosts = options.secrets?.hosts(project.name) ?? []
    return {
      entryPoints: entryPoints ?? null,
      ...(configError ? { configError } : {}),
      egress: [...new Set([...(config?.egress ?? []), ...secretHosts])].sort(),
      database: options.data?.status(project.name) ?? null,
      app: config ? await hasApp(project.name) : false,
    }
  }

  function secretStore(): SecretStore {
    if (!options.secrets) throw new HttpError(503, 'This Hobwork server has no secret store')
    return options.secrets
  }

  // Values go in and never come out: responses only name the secret and its hosts.
  async function putSecret(req: IncomingMessage, res: ServerResponse, project: string | undefined, name: string) {
    const body = (await readJson(req)) as { value?: unknown; hosts?: unknown } | null
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Send an object with value and hosts')
    if (body.value !== undefined && typeof body.value !== 'string') throw new HttpError(400, 'value must be a string')
    if (body.hosts !== undefined && !(Array.isArray(body.hosts) && body.hosts.every((h) => typeof h === 'string'))) {
      throw new HttpError(400, 'hosts must be a list of host names')
    }
    const store = secretStore()
    let created: boolean
    try {
      ;({ created } = store.set({ project, name, value: body.value, hosts: body.hosts as string[] | undefined }))
    } catch (err) {
      if (err instanceof SecretError) throw new HttpError(400, err.message)
      throw err
    }
    const secret = store.list(project).find((s) => s.name === name)
    json(res, created ? 201 : 200, secret)
  }

  function deleteSecret(res: ServerResponse, project: string | undefined, name: string) {
    if (!secretStore().remove(project, name)) throw new HttpError(404, `There is no secret called ${name}`)
    res.writeHead(204).end()
  }

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
      handle: async ({ res, params }) => {
        const project = requireProjectByName(host, params[0]!)
        const { status, current } = projectState(project)
        json(res, 200, {
          name: project.name,
          createdAt: project.createdAt,
          status,
          currentVersion: current?.number ?? null,
          versions: listVersions(host, project.name, VERSION_PAGE).map(versionView),
          ...(await projectDetail(project)),
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/invocations$/,
      handle: ({ res, params, query }) => {
        const project = requireProjectByName(host, params[0]!)
        const limit = pageSize(query, INVOCATION_PAGE, MAX_INVOCATION_PAGE)
        const rows = listInvocations(host, {
          project: project.name,
          kind: queryEnum(query, 'kind', INVOCATION_KINDS),
          status: queryEnum(query, 'status', INVOCATION_STATUSES),
          since: queryTime(query, 'since'),
          beforeId: queryInt(query, 'before'),
          limit: limit + 1,
        })
        json(res, 200, { invocations: rows.slice(0, limit).map((i) => invocationView(i, false)), more: rows.length > limit })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/invocations\/(\d+)$/,
      handle: ({ res, params }) => {
        const project = requireProjectByName(host, params[0]!)
        const invocation = getInvocation(host, positiveInt(params[1]))
        if (!invocation || invocation.project !== project.name) throw new HttpError(404, 'This run no longer exists')
        const logs = queryLogs(host, { project: project.name, invocationId: invocation.id, limit: INVOCATION_LOG_LINES })
        json(res, 200, { ...invocationView(invocation, true), logs })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/logs$/,
      handle: async ({ res, params, query }) => {
        const project = requireProjectByName(host, params[0]!)
        const view = queryEnum(query, 'view', LOG_VIEWS) ?? 'all'
        const after = queryInt(query, 'after')
        const filter: LogFilter = {
          project: project.name,
          afterId: after,
          eventsOnly: view === 'events',
          minLevel: view === 'problems' ? 'warn' : undefined,
          limit: pageSize(query, LOG_PAGE, MAX_LOG_PAGE),
        }
        // Read before querying, so a line appended in between is not skipped.
        const last = lastLogId(host, project.name)
        let lines = queryLogs(host, filter)
        // Long poll: with wait=1 and nothing new, answer when a line arrives.
        if (!lines.length && after !== undefined && after >= last && query.get('wait') === '1') {
          const closed = new AbortController()
          res.on('close', () => closed.abort())
          await waitForLogs(project.name, LOG_WAIT_MS, closed.signal)
          if (closed.signal.aborted) return
          lines = queryLogs(host, filter)
        }
        const cursor = lines.length ? lines.at(-1)!.id : Math.max(after ?? 0, last)
        json(res, 200, { lines, cursor })
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/webhooks\/([^/]+)\/token$/,
      handle: async ({ res, params }) => {
        const project = requireProjectByName(host, params[0]!)
        const name = params[1]!
        const config = await deployedConfig(project.name)
        if (!config || !(name in config.webhooks)) throw new HttpError(404, `${project.name} has no webhook called "${name}"`)
        const token = rotateWebhookToken(host, project.name, name)
        json(res, 200, { url: `${options.publicUrl}${webhookPath(project.name, name, token)}` })
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
      pattern: /^\/api\/projects\/([^/]+)\/secrets$/,
      handle: ({ res, params }) => {
        const project = requireProjectByName(host, params[0]!)
        json(res, 200, secretStore().effective(project.name))
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/projects\/([^/]+)\/secrets\/([^/]+)$/,
      handle: ({ req, res, params }) => putSecret(req, res, requireProjectByName(host, params[0]!).name, params[1]!),
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/projects\/([^/]+)\/secrets\/([^/]+)$/,
      handle: ({ res, params }) => deleteSecret(res, requireProjectByName(host, params[0]!).name, params[1]!),
    },
    {
      method: 'GET',
      pattern: /^\/api\/secrets$/,
      handle: ({ res }) => json(res, 200, secretStore().list()),
    },
    {
      method: 'PUT',
      pattern: /^\/api\/secrets\/([^/]+)$/,
      handle: ({ req, res, params }) => putSecret(req, res, undefined, params[0]!),
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/secrets\/([^/]+)$/,
      handle: ({ res, params }) => deleteSecret(res, undefined, params[0]!),
    },
    {
      method: 'GET',
      pattern: /^\/api\/agents$/,
      handle: ({ res }) => {
        const keys = listSshKeys(host.db)
        const connections = listConnections(host.db)
        json(
          res,
          200,
          listAgents(host.db).map((agent) => ({
            ...agent,
            sshKeys: keys.filter((key) => key.agentId === agent.id),
            connections: connections.get(agent.id) ?? [],
          })),
        )
      },
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
      pattern: /^\/api\/agents\/(\d+)\/ssh-keys$/,
      handle: async ({ req, res, params }) => {
        const agent = getAgent(host.db, positiveInt(params[0]))
        if (!agent) throw new HttpError(404, 'This agent no longer exists')
        const body = (await readJson(req)) as { publicKey?: unknown }
        try {
          json(res, 201, addSshKey(host.db, agent.id, typeof body?.publicKey === 'string' ? body.publicKey : ''))
        } catch (err) {
          if (err instanceof SshKeyError) throw new HttpError(400, err.message)
          throw err
        }
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/ssh-keys\/(\d+)$/,
      handle: ({ res, params }) => {
        if (!deleteSshKey(host.db, positiveInt(params[0]))) throw new HttpError(404, 'This SSH key was already removed')
        res.writeHead(204).end()
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
    {
      method: 'POST',
      pattern: /^\/api\/connections\/(\d+)\/revoke$/,
      handle: ({ res, params }) => {
        if (!revokeGrant(host.db, positiveInt(params[0]))) {
          throw new HttpError(404, 'This connection does not exist or is already revoked')
        }
        res.writeHead(204).end()
      },
    },
  ]

  // Returns false for paths it does not own, so later handlers can take them.
  return async (req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<boolean> => {
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
      await route.handle({ req, res, user, params, query })
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
