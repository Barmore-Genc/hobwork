import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SerializedRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import type { Host } from '../host.ts'
import { getProject, ProjectError } from '../projects.ts'
import { matchRoute } from './routes.ts'
import type { Runtime } from './runtime.ts'
import { HOOKS_PREFIX, verifyWebhookToken } from './webhooks.ts'

export const PROJECT_PREFIX = '/p/'

const MAX_BODY_BYTES = 10 * 1024 * 1024

// Headers that authenticate the caller to Hobwork. The handler never sees them.
const PRIVATE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade'])

// Decides who may call a project's routes: agents with a bearer token and
// signed-in users (project UIs), whose state-changing requests must pass the
// CSRF check (header x-hobwork-csrf: 1).
export type RouteAuthorizer = (req: IncomingMessage, project: string) => boolean

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function serialize(req: IncomingMessage, url: string): Promise<SerializedRequest> {
  const headers: [string, string][] = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase()
    if (!PRIVATE_HEADERS.has(name) && !HOP_BY_HOP.has(name)) headers.push([name, req.rawHeaders[i + 1]!])
  }
  const body = await readBody(req)
  return { method: req.method ?? 'GET', url, headers, ...(body.length ? { body: body.toString('base64') } : {}) }
}

function segmentsOf(pathname: string, prefix: string): string[] {
  return pathname.slice(prefix.length).split('/')
}

// Serves project routes (/p/<project>/api/...) and webhooks
// (/hooks/<project>/<name>/<token>). Returns false for other paths.
export function createRuntimeHttp(host: Host, runtime: Runtime, authorizeRoute: RouteAuthorizer) {
  async function invokeAndRespond(
    res: ServerResponse,
    project: string,
    input: Parameters<Runtime['invoke']>[1],
  ): Promise<void> {
    const outcome = await runtime.invoke(project, input)
    if (!outcome.ok) {
      const unavailable = outcome.error.name === 'RuntimeUnavailable'
      return sendJson(
        res,
        unavailable ? 503 : 500,
        { error: unavailable ? outcome.error.message : 'The handler failed', invocation: outcome.invocationId },
        { 'x-hobwork-invocation': String(outcome.invocationId) },
      )
    }
    const { status, headers, body } = outcome.response
    const out: Record<string, string | string[]> = {}
    for (const [name, value] of headers) {
      if (HOP_BY_HOP.has(name)) continue
      const existing = out[name]
      out[name] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value]
    }
    out['x-hobwork-invocation'] = String(outcome.invocationId)
    res.writeHead(status, out)
    res.end(Buffer.from(body, 'base64'))
  }

  async function handleRoute(req: IncomingMessage, res: ServerResponse, pathname: string, search: string) {
    const [project = '', api, ...rest] = segmentsOf(pathname, PROJECT_PREFIX)
    if (api !== 'api' || !getProject(host, project)) return sendJson(res, 404, { error: 'not found' })
    if (!authorizeRoute(req, project)) {
      return sendJson(res, 401, { error: 'Sign in, or send an agent token as "Authorization: Bearer <token>"' }, {
        'www-authenticate': 'Bearer realm="Hobwork"',
      })
    }
    const { routes } = await runtime.route(project)
    const match = matchRoute(routes, req.method ?? 'GET', `/${rest.join('/')}`)
    if (!match) return sendJson(res, 404, { error: `No route for ${req.method} /${rest.join('/')}` })
    if ('methodNotAllowed' in match) {
      return sendJson(res, 405, { error: 'Method not allowed' }, { allow: match.methodNotAllowed.join(', ') })
    }
    const request = await serialize(req, `http://${req.headers.host ?? 'localhost'}${pathname}${search}`)
    await invokeAndRespond(res, project, {
      kind: 'route',
      name: match.route.key,
      manual: false,
      request,
      params: match.params,
    })
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse, pathname: string, search: string) {
    const [project = '', name = '', token = '', ...rest] = segmentsOf(pathname, HOOKS_PREFIX)
    // Unknown project, webhook and token all look the same to the caller.
    if (
      rest.length ||
      !getProject(host, project) ||
      !verifyWebhookToken(host, project, name, token) ||
      !(await runtime.webhookExists(project, name))
    ) {
      return sendJson(res, 404, { error: 'not found' })
    }
    const request = await serialize(req, `http://${req.headers.host ?? 'localhost'}${HOOKS_PREFIX}${project}/${name}${search}`)
    await invokeAndRespond(res, project, { kind: 'webhook', name, manual: false, request })
  }

  return (req: IncomingMessage, res: ServerResponse, pathname: string, search: string): boolean => {
    const handler = pathname.startsWith(PROJECT_PREFIX)
      ? handleRoute
      : pathname.startsWith(HOOKS_PREFIX)
        ? handleWebhook
        : undefined
    if (!handler) return false
    handler(req, res, pathname, search).catch((err: unknown) => {
      if (res.headersSent) return void res.destroy()
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
      if (err instanceof ProjectError) return sendJson(res, 404, { error: err.message })
      console.error('Runtime HTTP request failed', err)
      sendJson(res, 500, { error: 'Internal server error' })
    })
    return true
  }
}
