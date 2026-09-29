import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SerializedRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import type { Host } from '../host.ts'
import { getProject, ProjectError } from '../projects.ts'
import { matchRoute } from './routes.ts'
import type { Runtime } from './runtime.ts'
import { HOOKS_PREFIX, verifyBranchWebhookToken, verifyWebhookToken } from './webhooks.ts'

export const PROJECT_PREFIX = '/p/'

const MAX_BODY_BYTES = 10 * 1024 * 1024

// Headers that authenticate the caller to Hobwork. The handler never sees them.
const PRIVATE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade'])

// Decides who may call a project's routes on the Hobwork origin: agents with a
// bearer token. People call them from the project UI on its app origin.
export type RouteAuthorizer = (req: IncomingMessage, project: string) => 'allowed' | 'unauthenticated' | 'forbidden'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
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

async function invokeAndRespond(
  res: ServerResponse,
  runtime: Runtime,
  project: string,
  input: Parameters<Runtime['invoke']>[1],
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const outcome = await runtime.invoke(project, input)
  if (!outcome.ok) {
    const unavailable = outcome.error.name === 'RuntimeUnavailable'
    return sendJson(
      res,
      unavailable ? 503 : 500,
      { error: unavailable ? outcome.error.message : 'The handler failed', invocation: outcome.invocationId },
      { ...extraHeaders, 'x-hobwork-invocation': String(outcome.invocationId) },
    )
  }
  const { status, headers, body } = outcome.response
  const out: Record<string, string | string[]> = { ...extraHeaders }
  for (const [name, value] of headers) {
    if (HOP_BY_HOP.has(name)) continue
    const existing = out[name]
    out[name] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value]
  }
  out['x-hobwork-invocation'] = String(outcome.invocationId)
  res.writeHead(status, out)
  res.end(Buffer.from(body, 'base64'))
}

// Answers a request for one of the project's routes. `path` is the part after
// /api, without the query string; `url` is what the handler sees.
export async function serveRoute(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: Runtime,
  options: { project: string; branch?: string; path: string; url: string; headers?: Record<string, string> },
): Promise<void> {
  const { project, branch, path, url, headers } = options
  const { routes } = await runtime.route(project, branch)
  const match = matchRoute(routes, req.method ?? 'GET', path)
  if (!match) return sendJson(res, 404, { error: `No route for ${req.method} ${path}` }, headers)
  if ('methodNotAllowed' in match) {
    return sendJson(res, 405, { error: 'Method not allowed' }, { ...headers, allow: match.methodNotAllowed.join(', ') })
  }
  const request = await serialize(req, url)
  await invokeAndRespond(
    res,
    runtime,
    project,
    { kind: 'route', name: match.route.key, manual: false, branch, request, params: match.params },
    headers,
  )
}

export function sendRuntimeError(res: ServerResponse, err: unknown) {
  if (res.headersSent) return void res.destroy()
  if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
  if (err instanceof ProjectError) return sendJson(res, 404, { error: err.message })
  console.error('Runtime HTTP request failed', err)
  sendJson(res, 500, { error: 'Internal server error' })
}

function segmentsOf(pathname: string, prefix: string): string[] {
  return pathname.slice(prefix.length).split('/')
}

// Serves project routes for agents (/p/<project>/api/...) and webhooks
// (/hooks/<project>/<name>/<token>), and sends old project UI links
// (/p/<project>/...) to the project's app origin. Returns false for other paths.
export function createRuntimeHttp(
  host: Host,
  runtime: Runtime,
  options: {
    authorizeRoute: RouteAuthorizer
    appOrigin: (project: string) => string | undefined
    // The branch whose preview label (<branch label>--<project>) this is.
    resolvePreview: (label: string) => Promise<{ project: string; branch: string } | undefined>
  },
) {
  async function handleProject(req: IncomingMessage, res: ServerResponse, pathname: string, search: string) {
    const [project = '', api, ...rest] = segmentsOf(pathname, PROJECT_PREFIX)
    if (!getProject(host, project)) return sendJson(res, 404, { error: 'not found' })
    if (api !== 'api') {
      const origin = options.appOrigin(project)
      if (!origin || (req.method !== 'GET' && req.method !== 'HEAD')) return sendJson(res, 404, { error: 'not found' })
      res.writeHead(302, { location: `${origin}/${[api ?? '', ...rest].join('/')}${search}`, 'cache-control': 'no-store' })
      return void res.end()
    }
    const authorized = options.authorizeRoute(req, project)
    if (authorized === 'forbidden') {
      return sendJson(res, 403, { error: 'This agent token has no access to this project, or can only send GET requests' })
    }
    if (authorized === 'unauthenticated') {
      return sendJson(res, 401, { error: 'Send an agent token as "Authorization: Bearer <token>"' }, {
        'www-authenticate': 'Bearer realm="Hobwork"',
      })
    }
    const url = `http://${req.headers.host ?? 'localhost'}${pathname}${search}`
    await serveRoute(req, res, runtime, { project, path: `/${rest.join('/')}`, url })
  }

  // /hooks/<project>/<name>/<token> calls the deployed version,
  // /hooks/<branch label>--<project>/<name>/<token> a branch preview.
  async function handleWebhook(req: IncomingMessage, res: ServerResponse, pathname: string, search: string) {
    const [target = '', name = '', token = '', ...rest] = segmentsOf(pathname, HOOKS_PREFIX)
    const preview = target.includes('--') ? await options.resolvePreview(target) : undefined
    const project = preview?.project ?? target
    const branch = preview?.branch
    // Unknown project, branch, webhook and token all look the same to the caller.
    if (
      rest.length ||
      (target.includes('--') && !preview) ||
      !getProject(host, project) ||
      !(branch === undefined
        ? verifyWebhookToken(host, project, name, token)
        : verifyBranchWebhookToken(host, project, branch, name, token)) ||
      !(await runtime.webhookExists(project, name, branch))
    ) {
      return sendJson(res, 404, { error: 'not found' })
    }
    const request = await serialize(req, `http://${req.headers.host ?? 'localhost'}${HOOKS_PREFIX}${target}/${name}${search}`)
    await invokeAndRespond(res, runtime, project, { kind: 'webhook', name, manual: false, branch, request })
  }

  return (req: IncomingMessage, res: ServerResponse, pathname: string, search: string): boolean => {
    const handler = pathname.startsWith(PROJECT_PREFIX)
      ? handleProject
      : pathname.startsWith(HOOKS_PREFIX)
        ? handleWebhook
        : undefined
    if (!handler) return false
    handler(req, res, pathname, search).catch((err: unknown) => sendRuntimeError(res, err))
    return true
  }
}
