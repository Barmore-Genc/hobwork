import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { defaultIcon, ICONS_DIR, iconFile, LIST_ICON_SIZE, letterIconSvg } from '../../../packages/sdk/src/icons/icon.ts'
import { AccessError, parseAccess, type Access } from '../access.ts'
import { createAgentToken, getAgent, listAgents, MAX_AGENT_NAME, revokeAgentToken } from '../agents.ts'
import type { AppTarget } from '../apps/origins.ts'
import { branchRoutes } from './branches.ts'
import type { Auth } from '../auth/auth.ts'
import type { User } from '../auth/users.ts'
import type { Delivery } from '../delivery.ts'
import type { Host } from '../host.ts'
import { HttpError, json, readJson } from '../http.ts'
import { listConnections, revokeGrant } from '../oauth/grants.ts'
import { latestRun } from '../pipeline/runner.ts'
import { getProject, getProjectOrRenamed, listProjects, ProjectError, renamedProject, type Project } from '../projects.ts'
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
import { fileStats, sendFile } from '../static.ts'
import {
  SecretConflictError,
  SecretError,
  SecretNotFoundError,
  type Actor,
  type SecretChange,
  type SecretStore,
} from '../secrets.ts'
import type { StorageUsage } from '../storage.ts'
import { addSshKey, listSshKeys, revokeSshKey, SshKeyError } from '../ssh/keys.ts'
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

export const INVOCATION_KINDS: InvocationKind[] = ['route', 'webhook', 'cron', 'trigger']
export const INVOCATION_STATUSES: InvocationStatus[] = ['running', 'ok', 'error']
const LOG_VIEWS = ['all', 'events', 'problems'] as const

export type ApiRoute = {
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

const iconUrl = (project: string) => `/api/projects/${encodeURIComponent(project)}/icon`

function versionView(version: Version) {
  return {
    number: version.number,
    summary: version.summary,
    by: version.user ?? version.agent,
    restoredFrom: version.restoredFrom,
    createdAt: version.createdAt,
  }
}

function userActor(user: User): Actor {
  return { kind: 'user', id: user.id, name: user.name }
}

function requireProjectByName(host: Host, name: string): Project {
  const project = getProject(host, name)
  if (!project) {
    const renamed = renamedProject(host, name)
    throw new HttpError(404, renamed ? `${name} is now called ${renamed.name}` : `There is no project called "${name}"`)
  }
  return project
}

function positiveInt(value: string | undefined): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'Not found')
  return n
}

export function queryInt(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, `${name} must be a whole number`)
  return n
}

export function pageSize(query: URLSearchParams, fallback: number, max: number): number {
  return Math.min(Math.max(queryInt(query, 'limit') ?? fallback, 1), max)
}

export function queryEnum<T extends string>(query: URLSearchParams, name: string, values: readonly T[]): T | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  if (!values.includes(raw as T)) throw new HttpError(400, `${name} must be one of ${values.join(', ')}`)
  return raw as T
}

export function queryTime(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  const time = Date.parse(raw)
  if (Number.isNaN(time)) throw new HttpError(400, `${name} must be a date and time`)
  return new Date(time).toISOString()
}

export function invocationView(invocation: InvocationRecord, full: boolean) {
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

function accessOf(host: Host, value: unknown): Access {
  try {
    return parseAccess(host.db, value)
  } catch (err) {
    if (err instanceof AccessError) throw new HttpError(400, err.message)
    throw err
  }
}

export function createApiRoutes(options: {
  host: Host
  auth: Auth
  delivery: Delivery
  publicUrl: string
  appOrigin?: (target: AppTarget) => string | undefined
  runtime?: Runtime
  data?: ProjectData
  secrets?: SecretStore
  storage?: StorageUsage
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
        device: entry.device ?? null,
        lastRun: lastRun('trigger', name),
      })),
    }
    const secretHosts = options.secrets?.hosts(project.name) ?? []
    return {
      entryPoints: entryPoints ?? null,
      ...(configError ? { configError } : {}),
      egress: [...new Set([...(config?.egress ?? []), ...secretHosts])].sort(),
      database: options.data?.status(project.name) ?? null,
      ...(options.storage ? { storage: options.storage.get(project) } : {}),
      app: config ? await hasApp(project.name) : false,
      appUrl: options.appOrigin?.({ project: project.name }) ?? null,
    }
  }

  function secretStore(): SecretStore {
    if (!options.secrets) throw new HttpError(503, 'This Hobwork server has no secret store')
    return options.secrets
  }

  function secretCall<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      if (err instanceof SecretNotFoundError) throw new HttpError(404, err.message)
      if (err instanceof SecretConflictError) throw new HttpError(409, err.message)
      if (err instanceof SecretError) throw new HttpError(400, err.message)
      throw err
    }
  }

  async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
    const body = (await readJson(req)) as unknown
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object')
    return body as Record<string, unknown>
  }

  // Values go in and never come out: responses only name the secret and its hosts.
  function secretChange(body: Record<string, unknown>): SecretChange {
    for (const field of ['name', 'value'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'string') throw new HttpError(400, `${field} must be a string`)
    }
    if (body.hosts !== undefined && !(Array.isArray(body.hosts) && body.hosts.every((h) => typeof h === 'string'))) {
      throw new HttpError(400, 'hosts must be a list of host names')
    }
    return {
      name: body.name as string | undefined,
      value: body.value as string | undefined,
      hosts: body.hosts as string[] | undefined,
    }
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

  const routes: ApiRoute[] = [
    ...branchRoutes({ host, runtime, appOrigin: options.appOrigin }),
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
              iconUrl: iconUrl(project.name),
              ...(options.storage ? { storage: options.storage.get(project) } : {}),
            }
          }),
        ),
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)$/,
      handle: async ({ res, params }) => {
        // The web UI moves links to a renamed project's old name to its new one.
        const project = getProjectOrRenamed(host, params[0]!) ?? requireProjectByName(host, params[0]!)
        const { status, current } = projectState(project)
        json(res, 200, {
          name: project.name,
          createdAt: project.createdAt,
          status,
          currentVersion: current?.number ?? null,
          iconUrl: iconUrl(project.name),
          versions: listVersions(host, project.name, VERSION_PAGE).map(versionView),
          ...(await projectDetail(project)),
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/icon$/,
      handle: async ({ req, res, params }) => {
        const project = requireProjectByName(host, params[0]!)
        // Never builds: a list of projects must not start builds for each of them.
        const build = await runtime?.storedBuild(project.name).catch(() => undefined)
        const path = build && join(build, ICONS_DIR, iconFile(LIST_ICON_SIZE))
        const stats = path ? fileStats(path) : undefined
        if (path && stats) return sendFile(req, res, path, stats, 'no-cache')
        const svg = Buffer.from(letterIconSvg(defaultIcon(project.name)))
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': svg.length, 'cache-control': 'no-cache' })
        res.end(svg)
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/invocations$/,
      handle: ({ res, params, query }) => {
        const project = requireProjectByName(host, params[0]!)
        const limit = pageSize(query, INVOCATION_PAGE, MAX_INVOCATION_PAGE)
        const branch = query.get('branch')
        const rows = listInvocations(host, {
          project: project.name,
          // main is the deployed version; any other name is a branch preview.
          branch: branch ? (branch === project.defaultBranch ? null : branch) : undefined,
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
      handle: ({ res, params }) => json(res, 200, secretStore().assigned(requireProjectByName(host, params[0]!).name)),
    },
    {
      // Assigns an existing secret under the env name in the path. Values and
      // hosts are only set through /api/secrets.
      method: 'PUT',
      pattern: /^\/api\/projects\/([^/]+)\/secrets\/([^/]+)$/,
      handle: async ({ req, res, user, params }) => {
        const project = requireProjectByName(host, params[0]!)
        const { secretId } = await readObject(req)
        if (typeof secretId !== 'number' || !Number.isSafeInteger(secretId)) {
          throw new HttpError(400, 'secretId must be the ID of a secret')
        }
        json(res, 201, secretCall(() => secretStore().assign(project.name, secretId, params[1]!, userActor(user))))
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/projects\/([^/]+)\/secrets\/([^/]+)$/,
      handle: ({ res, user, params }) => {
        const project = requireProjectByName(host, params[0]!)
        if (!secretStore().unassign(project.name, params[1]!, userActor(user))) {
          throw new HttpError(404, `${project.name} has no secret called ${params[1]}`)
        }
        res.writeHead(204).end()
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/secrets$/,
      handle: ({ res }) => json(res, 200, secretStore().list()),
    },
    {
      // With assign ({ project, envName }) the new secret is assigned in the same step.
      method: 'POST',
      pattern: /^\/api\/secrets$/,
      handle: async ({ req, res, user }) => {
        const body = await readObject(req)
        const { name, value, hosts } = secretChange(body)
        const assign = body.assign as { project?: unknown; envName?: unknown } | undefined
        if (assign !== undefined && (typeof assign?.project !== 'string' || typeof assign.envName !== 'string')) {
          throw new HttpError(400, 'assign needs a project and an envName')
        }
        const target = assign && {
          project: requireProjectByName(host, assign.project as string).name,
          envName: assign.envName as string,
        }
        const created = secretCall(() =>
          secretStore().create({ name: name ?? '', value: value ?? '', hosts: hosts ?? [], assign: target }, userActor(user)),
        )
        json(res, 201, created)
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/secrets\/(\d+)$/,
      handle: async ({ req, res, user, params }) => {
        const change = secretChange(await readObject(req))
        json(res, 200, secretCall(() => secretStore().update(positiveInt(params[0]), change, userActor(user))))
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/secrets\/(\d+)$/,
      handle: ({ res, user, params }) => {
        if (!secretStore().remove(positiveInt(params[0]), userActor(user))) throw new HttpError(404, 'This secret no longer exists')
        res.writeHead(204).end()
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/secrets\/host-requests\/(\d+)$/,
      handle: ({ res, params }) => {
        const request = secretStore().hostRequest(positiveInt(params[0]))
        if (!request) throw new HttpError(404, 'This request no longer exists')
        json(res, 200, request)
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/secrets\/host-requests\/(\d+)\/(approve|deny)$/,
      handle: ({ res, user, params }) => {
        const approve = params[1] === 'approve'
        json(res, 200, secretCall(() => secretStore().decideHostRequest(positiveInt(params[0]), approve, userActor(user))))
      },
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
        const body = (await readJson(req)) as { name?: unknown; access?: unknown }
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (!name) throw new HttpError(400, 'Give the agent a name')
        if (name.length > MAX_AGENT_NAME) throw new HttpError(400, `Use at most ${MAX_AGENT_NAME} characters`)
        if (listAgents(host.db).some((agent) => agent.name === name)) {
          throw new HttpError(409, `An agent called "${name}" already exists`)
        }
        const { agent, token } = createAgentToken(host.db, name, accessOf(host, body?.access))
        json(res, 201, { agent, token })
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/agents\/(\d+)\/tokens$/,
      handle: async ({ req, res, params }) => {
        const agent = getAgent(host.db, positiveInt(params[0]))
        if (!agent) throw new HttpError(404, 'This agent no longer exists')
        const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined
        const body = hasBody ? ((await readJson(req)) as { access?: unknown } | null) : null
        const { token } = createAgentToken(host.db, agent.name, accessOf(host, body?.access))
        json(res, 201, { agent, token })
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/agents\/(\d+)\/ssh-keys$/,
      handle: async ({ req, res, user, params }) => {
        const agent = getAgent(host.db, positiveInt(params[0]))
        if (!agent) throw new HttpError(404, 'This agent no longer exists')
        const body = (await readJson(req)) as { name?: unknown; publicKey?: unknown }
        const text = (value: unknown) => (typeof value === 'string' ? value : '')
        try {
          json(res, 201, addSshKey(host.db, agent.id, text(body?.name), text(body?.publicKey), { via: 'web', userId: user.id }))
        } catch (err) {
          if (err instanceof SshKeyError) throw new HttpError(400, err.message)
          throw err
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/ssh-keys\/(\d+)\/revoke$/,
      handle: ({ res, params }) => {
        if (!revokeSshKey(host.db, positiveInt(params[0]))) {
          throw new HttpError(404, 'This SSH key does not exist or is already revoked')
        }
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
    let route: ApiRoute | undefined
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
