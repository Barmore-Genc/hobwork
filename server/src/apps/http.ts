import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Auth } from '../auth/auth.ts'
import type { Allowlist } from '../config.ts'
import type { Host } from '../host.ts'
import { parseCookies, setCookie } from '../http.ts'
import { getProject, renamedProject, type Project } from '../projects.ts'
import { BuildError } from '../runtime/builds.ts'
import { sendJson, sendRuntimeError, serveRoute } from '../runtime/http.ts'
import { ICONS_PREFIX, MANIFEST_PATH, sendUiText, serveAppIcons, serveProjectUi, uiHeaders } from '../runtime/project-ui.ts'
import type { CspSources } from '../runtime/csp.ts'
import type { Runtime } from '../runtime/runtime.ts'
import { THEME_PREFIX } from '../static.ts'
import { parseLabel, type AppOrigins, type AppTarget } from './origins.ts'
import { createAppCode, findAppSession, redeemAppCode, type AppScope } from './sessions.ts'

// On the Hobwork origin: turns the Hobwork session into a code for one app origin.
export const APP_AUTH_PATH = '/auth/app'
// On an app origin: exchanges that code for the app's own session cookie.
export const CALLBACK_PATH = '/_hobwork/callback'
const RESERVED_PREFIX = '/_hobwork/'
const API_PREFIX = '/api/'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const CSRF_HEADER = 'x-hobwork-csrf'

type Resolved = { project: Project; target: AppTarget; origin: string; scope: AppScope }

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(`${text}\n`)
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers })
  res.end()
}

// A path on the app origin to send the browser back to. Anything that is not
// a plain path there (another origin, "//host", "/\host", a scheme) is refused.
export function appReturnPath(value: string | null | undefined, origin: string): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined
  let url: URL
  try {
    url = new URL(value, origin)
  } catch {
    return undefined
  }
  if (url.origin !== origin || url.pathname.startsWith(RESERVED_PREFIX)) return undefined
  return `${url.pathname}${url.search}`
}

export function createAppHttp(options: {
  host: Host
  auth: Auth
  allowlist: Allowlist
  origins: AppOrigins
  publicUrl: string
  runtime?: Runtime
  // Serves /theme/theme.css and its fonts, which project UIs load from their own origin.
  serveTheme: (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean
}) {
  const { host, auth, allowlist, origins, publicUrl, runtime } = options
  const secure = origins.secure
  // Host-only on each app origin; the __Host- prefix also keeps a sibling app
  // from planting its own cookie with a Domain attribute.
  const cookieName = secure ? '__Host-hobwork_app' : 'hobwork_app'
  const frameHeaders = uiHeaders(publicUrl)

  async function resolve(target: AppTarget): Promise<Resolved | undefined> {
    const project = getProject(host, target.project)
    if (!project) return undefined
    const origin = origins.origin(target)
    if (!origin) return undefined
    return { project, target, origin, scope: { projectId: project.id, branch: target.branch ?? null } }
  }

  // A version whose hobwork.json cannot be read gets the default policy.
  async function cspOf(app: Resolved): Promise<CspSources | undefined> {
    return runtime?.csp(app.target.project, app.target.branch).catch(() => undefined)
  }

  async function resolveHost(hostHeader: string | undefined): Promise<Resolved | undefined> {
    const label = origins.labelOf(hostHeader)
    if (!label) return undefined
    const { project, branchLabel } = parseLabel(label)
    if (!getProject(host, project)) return undefined
    if (branchLabel === undefined) return resolve({ project })
    const branch = await origins.resolveBranch(host, project, branchLabel)
    return branch === undefined ? undefined : resolve({ project, branch })
  }

  function signInUrl(app: Resolved, returnTo: string): string {
    const params = new URLSearchParams({ project: app.target.project })
    if (app.target.branch !== undefined) params.set('branch', app.target.branch)
    params.set('returnTo', returnTo)
    return `${publicUrl}${APP_AUTH_PATH}?${params}`
  }

  function appUser(req: IncomingMessage, app: Resolved) {
    const token = parseCookies(req.headers.cookie).get(cookieName)
    return token ? findAppSession(host.db, allowlist, token, app.scope) : undefined
  }

  function csrfError(req: IncomingMessage, app: Resolved): string | undefined {
    if (SAFE_METHODS.has(req.method ?? 'GET')) return undefined
    if (req.headers[CSRF_HEADER] !== '1') return `Send the header "${CSRF_HEADER}: 1" with this request`
    const origin = req.headers.origin
    if (origin !== undefined && origin !== app.origin) return 'The request comes from another site'
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'The request comes from another site'
    return undefined
  }

  // GET /auth/app?project=<name>[&branch=<branch>]&returnTo=<app URL>, on the
  // Hobwork origin.
  async function handoff(req: IncomingMessage, res: ServerResponse, search: URLSearchParams) {
    const branch = search.get('branch') ?? undefined
    const app = await resolve({ project: search.get('project') ?? '', ...(branch === undefined ? {} : { branch }) })
    const returnTo = search.get('returnTo')
    let target: URL | undefined
    try {
      target = returnTo ? new URL(returnTo) : undefined
    } catch {}
    const path = app && target && target.origin === app.origin ? appReturnPath(`${target.pathname}${target.search}`, app.origin) : undefined
    if (!app || !path) return sendText(res, 400, 'This link to an app is not valid. Open the app from Hobwork.')
    const session = auth.currentSession(req)
    if (!session) return redirect(res, `/login?returnTo=${encodeURIComponent(`${APP_AUTH_PATH}?${search}`)}`)
    const code = createAppCode(host.db, session.id, app.scope)
    redirect(res, `${app.origin}${CALLBACK_PATH}?${new URLSearchParams({ code, returnTo: path })}`)
  }

  function callback(req: IncomingMessage, res: ServerResponse, app: Resolved, search: URLSearchParams) {
    if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed', { ...frameHeaders, allow: 'GET' })
    const path = appReturnPath(search.get('returnTo'), app.origin) ?? '/'
    const session = redeemAppCode(host.db, search.get('code') ?? '', app.scope)
    if (!session) {
      // A reload or the back button can land here with a used code.
      if (appUser(req, app)) return redirect(res, path, frameHeaders)
      return sendText(res, 400, 'This sign-in link expired or was already used. Open the app again.', frameHeaders)
    }
    const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000))
    setCookie(res, cookieName, session.token, { maxAge, secure })
    redirect(res, path, frameHeaders)
  }

  async function serveUi(req: IncomingMessage, res: ServerResponse, app: Resolved, pathname: string) {
    if (!runtime) return sendUiText(res, publicUrl, 503, 'This Hobwork host does not run hob apps.')
    let build: string
    try {
      build = await runtime.build(app.target.project, app.target.branch)
    } catch (err) {
      if (!(err instanceof BuildError)) throw err
      console.error(`Building the UI of ${app.target.project} failed`, err)
      return sendUiText(res, publicUrl, 503, `${app.target.project} could not be prepared. Try again in a moment.`)
    }
    serveProjectUi(req, res, { project: app.target.project, build, rest: pathname.slice(1), hobworkOrigin: publicUrl, csp: await cspOf(app) })
  }

  // Only a build that is already stored: these answer without a session, and
  // must not start one.
  async function serveIcons(req: IncomingMessage, res: ServerResponse, app: Resolved, pathname: string) {
    const build = await runtime?.storedBuild(app.target.project, app.target.branch).catch(() => undefined)
    serveAppIcons(req, res, { project: app.target.project, build, pathname, hobworkOrigin: publicUrl })
  }

  // Bookmarks and home screen icons of a renamed project's app lead to its new origin.
  function renamedOrigin(hostHeader: string | undefined): string | undefined {
    const label = origins.labelOf(hostHeader)
    if (!label || parseLabel(label).branchLabel !== undefined) return undefined
    const project = renamedProject(host, label)
    return project && origins.origin({ project: project.name })
  }

  async function serveApp(req: IncomingMessage, res: ServerResponse) {
    const app = await resolveHost(req.headers.host)
    if (!app) {
      const moved = SAFE_METHODS.has(req.method ?? 'GET') ? renamedOrigin(req.headers.host) : undefined
      if (moved) {
        const { pathname, search } = new URL(req.url ?? '/', moved)
        return redirect(res, `${moved}${pathname}${search}`, frameHeaders)
      }
      return sendText(res, 404, 'There is no app here.', frameHeaders)
    }
    const url = new URL(req.url ?? '/', app.origin)
    const { pathname, search } = url
    if (pathname === CALLBACK_PATH) return callback(req, res, app, url.searchParams)
    if (pathname.startsWith(THEME_PREFIX) && options.serveTheme(req, res, pathname)) return
    if (pathname === MANIFEST_PATH || pathname.startsWith(ICONS_PREFIX)) return serveIcons(req, res, app, pathname)
    const user = appUser(req, app)
    if (!user) {
      const page = !pathname.startsWith(API_PREFIX) && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
      if (page) return redirect(res, signInUrl(app, `${app.origin}${pathname}${search}`), frameHeaders)
      return sendJson(res, 401, { error: 'Sign in to continue' }, frameHeaders)
    }
    if (pathname.startsWith(API_PREFIX)) {
      const error = csrfError(req, app)
      if (error) return sendJson(res, 403, { error }, frameHeaders)
      if (!runtime) return sendJson(res, 503, { error: 'This Hobwork host does not run handlers' }, frameHeaders)
      return serveRoute(req, res, runtime, {
        project: app.target.project,
        branch: app.target.branch,
        path: pathname.slice(API_PREFIX.length - 1),
        url: url.href,
        headers: uiHeaders(publicUrl, await cspOf(app)),
      })
    }
    if (pathname.startsWith(RESERVED_PREFIX)) return sendText(res, 404, 'Not found', frameHeaders)
    await serveUi(req, res, app, pathname)
  }

  return {
    // True when the request is for an app origin rather than Hobwork itself.
    isAppRequest: (req: IncomingMessage) => origins.labelOf(req.headers.host) !== undefined,

    handle(req: IncomingMessage, res: ServerResponse) {
      serveApp(req, res).catch((err: unknown) => sendRuntimeError(res, err))
    },

    async handleHandoff(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams) {
      if (pathname !== APP_AUTH_PATH) return false
      if (req.method !== 'GET') {
        sendText(res, 405, 'Method not allowed', { allow: 'GET' })
        return true
      }
      await handoff(req, res, search)
      return true
    },

    // Where the Hobwork web UI opens a project's app, if it can have one.
    origin: (target: AppTarget) => origins.origin(target),
  }
}
