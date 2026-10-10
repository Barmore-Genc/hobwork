import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Auth } from '../auth/auth.ts'
import type { Allowlist } from '../config.ts'
import type { Host } from '../host.ts'
import { parseCookies, setCookie } from '../http.ts'
import { getProject, renamedProject, type Project } from '../projects.ts'
import { BuildError } from '../runtime/builds.ts'
import { sendJson, sendRuntimeError, serveRoute, serveWebhook } from '../runtime/http.ts'
import { ICONS_PREFIX, MANIFEST_PATH, sendUiText, serveAppIcons, serveProjectUi, uiHeaders } from '../runtime/project-ui.ts'
import type { CspSources } from '../runtime/csp.ts'
import { findStaticMount, projectFilesDir, serveStaticFile, type StaticMount } from '../runtime/files.ts'
import type { Runtime } from '../runtime/runtime.ts'
import { THEME_PREFIX } from '../static.ts'
import { parseLabel, type AppOrigins, type AppTarget } from './origins.ts'
import { HOOKS_PREFIX, verifyBranchWebhookToken, verifyWebhookToken } from '../runtime/webhooks.ts'
import { createAppCode, findAppSession, redeemAppCode, type AppScope, type AppSession } from './sessions.ts'
import type { Caller } from '../../../packages/sdk/src/people.ts'
import { getDevice, markDeviceActive } from '../devices/store.ts'
import { personOf } from '../people.ts'
import { findShareLink, isShareToken } from './share-links.ts'
import { HttpError, readJson } from '../http.ts'
import { createUploads, isUploadToken, uploadOfToken, type Completed, type UploadTarget } from '../runtime/uploads.ts'
import { UPLOAD_FILES_PATH, UPLOADS_PATH, type UploadEvent } from '../../../packages/sdk/src/uploads.ts'
import { decodeFilePath } from '../runtime/files.ts'

// On the Hobwork origin: turns the Hobwork session into a code for one app origin.
export const APP_AUTH_PATH = '/auth/app'
// On an app origin: exchanges that code for the app's own session cookie.
export const CALLBACK_PATH = '/_hobwork/callback'
// On an app origin: turns a share link from show_hob into its cookie.
export const SHARE_PATH = '/_hobwork/share'
const RESERVED_PREFIX = '/_hobwork/'
const API_PREFIX = '/api/'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// What a read-only share link may send to routes, like read-only agent tokens.
const READ_METHODS = new Set(['GET', 'HEAD'])
const CSRF_HEADER = 'x-hobwork-csrf'

type Resolved = { project: Project; target: AppTarget; origin: string; scope: AppScope }

// Who a request to an app origin acts for: a signed-in user's app session, or
// a share link (as a cookie, or as a bearer token from an agent).
type Viewer = { shared: false; session: AppSession } | { shared: true; readOnly: boolean; bearer: boolean }

const EXPIRED_LINK = 'This link has expired or was revoked. Ask for a new one, or open the app from Hobwork.'

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
  const shareCookieName = secure ? '__Host-hobwork_share' : 'hobwork_share'
  const frameHeaders = uiHeaders(publicUrl)
  // A share link is meant to be framed by MCP clients, whose origins Hobwork
  // cannot know. Its cookie is partitioned by top-level site, so a page that
  // frames the app elsewhere gets no session from it.
  const sharedFrameHeaders = uiHeaders('*')
  const uploads = createUploads(host)

  async function resolve(target: AppTarget): Promise<Resolved | undefined> {
    const project = getProject(host, target.project)
    if (!project) return undefined
    const origin = origins.origin(target)
    if (!origin) return undefined
    return { project, target, origin, scope: { projectId: project.id, branch: target.branch ?? null } }
  }

  // A version whose hobwork.json cannot be read lets no other app in.
  async function crossAppRequestsOf(app: Resolved): Promise<string[]> {
    return (await runtime?.crossAppRequests(app.target.project, app.target.branch).catch(() => undefined)) ?? []
  }

  // The origin a browser request comes from, when it says. Origin is absent on
  // most GETs, so Referer (which the Hobwork UI and the apps send at least as
  // an origin) fills in.
  function sourceOrigin(req: IncomingMessage): string | undefined {
    const origin = req.headers.origin
    const from = origin !== undefined && origin !== 'null' ? origin : req.headers.referer
    if (!from) return undefined
    try {
      return new URL(from).origin
    } catch {
      return undefined
    }
  }

  // Sibling app origins are same-site, so their requests carry this app's
  // SameSite=Lax cookie. Refuses them unless the app's hobwork.json lists the
  // hob they come from, on every method. Requests from the Hobwork origin (the
  // web UI framing the app) and from other branches of the same hob pass, and
  // so does anything that is not same-site: those carry no cookie. A top-level
  // navigation to a page passes from anywhere, since that is a link.
  async function crossApp(req: IncomingMessage, app: Resolved, pathname: string): Promise<{ error?: string; listed?: true }> {
    const site = req.headers['sec-fetch-site']
    const source = sourceOrigin(req)
    // Browsers that send no Sec-Fetch-Site still send Origin on writes.
    const sameSite = site === 'same-site' || (site === undefined && req.headers.origin !== undefined && source !== app.origin)
    if (!sameSite || source === publicUrl) return {}

    const dest = req.headers['sec-fetch-dest']
    const page = !pathname.startsWith(API_PREFIX)
    const fromLabel = source === undefined ? undefined : origins.labelOf(new URL(source).host)
    if (fromLabel === undefined) {
      // No usable Origin or Referer: a page load or frame of the UI cannot be
      // told apart from the Hobwork UI's own, routes can.
      const framesOrOpens = dest === 'document' || dest === 'iframe'
      return page && framesOrOpens ? {} : { error: 'This app does not accept requests from other sites' }
    }
    const hob = parseLabel(fromLabel).project
    if (hob === app.target.project) return {}
    if ((await crossAppRequestsOf(app)).includes(hob)) return { listed: true }
    if (page && dest === 'document') return {}
    return { error: `This app does not accept requests from the app of ${hob}` }
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

  // The share cookie is SameSite=None, so requests other sites send carry it.
  // It counts for opening or framing a page from anywhere, and otherwise only
  // for the page's own requests.
  function shareCookieUsable(req: IncomingMessage, pathname: string): boolean {
    const site = req.headers['sec-fetch-site']
    if (site === undefined || site === 'same-origin' || site === 'none') return true
    return req.headers['sec-fetch-mode'] === 'navigate' && !pathname.startsWith(API_PREFIX)
  }

  // 'expired' when the request brings a share link that no longer opens this app.
  function viewerOf(req: IncomingMessage, app: Resolved, pathname: string): Viewer | 'expired' | undefined {
    const header = req.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined
    if (bearer !== undefined && isShareToken(bearer)) {
      const link = findShareLink(host.db, bearer, app.scope)
      return link ? { shared: true, readOnly: link.readOnly, bearer: true } : 'expired'
    }
    const session = appUser(req, app)
    if (session) return { shared: false, session }
    const cookie = parseCookies(req.headers.cookie).get(shareCookieName)
    if (cookie === undefined || !shareCookieUsable(req, pathname)) return undefined
    const link = findShareLink(host.db, cookie, app.scope)
    return link ? { shared: true, readOnly: link.readOnly, bearer: false } : 'expired'
  }

  // Read on every request, so a renamed device or a new time zone shows at once.
  function callerOf(session: AppSession): Caller {
    const device = session.deviceId === null ? undefined : getDevice(host.db, session.deviceId)
    return {
      person: personOf(host.db, session.user),
      device: device ? { name: device.name, platform: device.platform } : null,
    }
  }

  // `listed`: the request comes from an app that hobwork.json lets in, so a
  // different origin is expected.
  function csrfError(req: IncomingMessage, app: Resolved, listed = false): string | undefined {
    if (SAFE_METHODS.has(req.method ?? 'GET')) return undefined
    if (req.headers[CSRF_HEADER] !== '1') return `Send the header "${CSRF_HEADER}: 1" with this request`
    if (listed) return undefined
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

  // GET /_hobwork/share?token=<token>&returnTo=<path>. The token stays the
  // credential: the cookie holds it and expires with the link.
  function share(req: IncomingMessage, res: ServerResponse, app: Resolved, search: URLSearchParams) {
    if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed', { ...sharedFrameHeaders, allow: 'GET' })
    const token = search.get('token') ?? ''
    const link = findShareLink(host.db, token, app.scope)
    if (!link) return sendText(res, 401, EXPIRED_LINK, sharedFrameHeaders)
    const maxAge = Math.max(0, Math.floor((Date.parse(link.expiresAt) - Date.now()) / 1000))
    setCookie(res, shareCookieName, token, { maxAge, secure, crossSite: true })
    redirect(res, appReturnPath(search.get('returnTo'), app.origin) ?? '/', sharedFrameHeaders)
  }

  async function serveUi(req: IncomingMessage, res: ServerResponse, app: Resolved, pathname: string, frameAncestors: string) {
    if (!runtime) return sendUiText(res, frameAncestors, 503, 'This Hobwork host does not run hob apps.')
    let build: string
    try {
      build = await runtime.build(app.target.project, app.target.branch)
    } catch (err) {
      if (!(err instanceof BuildError)) throw err
      console.error(`Building the UI of ${app.target.project} failed`, err)
      return sendUiText(res, frameAncestors, 503, `${app.target.project} could not be prepared. Try again in a moment.`)
    }
    serveProjectUi(req, res, { project: app.target.project, build, rest: pathname.slice(1), frameAncestors, csp: await cspOf(app) })
  }

  // A version whose hobwork.json cannot be read serves no files.
  async function staticMountOf(app: Resolved, pathname: string): Promise<StaticMount | undefined> {
    const mounts = await runtime?.staticMounts(app.target.project, app.target.branch).catch(() => undefined)
    return mounts && findStaticMount(mounts, pathname)
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, app: Resolved, mount: StaticMount, pathname: string) {
    return serveStaticFile(req, res, { files: projectFilesDir(host, app.target.project), mount, pathname })
  }

  // Only a build that is already stored: these answer without a session, and
  // must not start one.
  async function serveIcons(req: IncomingMessage, res: ServerResponse, app: Resolved, pathname: string) {
    const build = await runtime?.storedBuild(app.target.project, app.target.branch).catch(() => undefined)
    serveAppIcons(req, res, { project: app.target.project, build, pathname, frameAncestors: publicUrl })
  }

  // Bookmarks and home screen icons of a renamed project's app lead to its new origin.
  function renamedOrigin(hostHeader: string | undefined): string | undefined {
    const label = origins.labelOf(hostHeader)
    if (!label || parseLabel(label).branchLabel !== undefined) return undefined
    const project = renamedProject(host, label)
    return project && origins.origin({ project: project.name })
  }

  // <app origin>/_hobwork/hooks/<name>/<token>. The token is the only credential:
  // the app session cookie is not read and Cookie never reaches the handler.
  async function webhook(req: IncomingMessage, res: ServerResponse, app: Resolved, pathname: string, search: string) {
    const [name = '', token = '', ...rest] = pathname.slice(HOOKS_PREFIX.length).split('/')
    const { project, branch } = app.target
    // Unknown hob, webhook and token all look the same to the caller.
    const valid = !rest.length && (branch === undefined ? verifyWebhookToken(host, project, name, token) : verifyBranchWebhookToken(host, project, branch, name, token))
    if (!valid || !runtime) return sendJson(res, 404, { error: 'not found' })
    const url = `${app.origin}${HOOKS_PREFIX}${name}${search}`
    await serveWebhook(req, res, runtime, { project, branch, name, url })
  }

  // Runs the triggers of the upload a file arrived through. The upload has
  // already succeeded, so a failing trigger only shows in the hob's log.
  async function uploadTriggers(app: Resolved, done: Completed, caller: Caller | undefined) {
    if (!runtime) return
    const { triggers } = await runtime.uploads(app.target.project, app.target.branch)
    const payload: UploadEvent = { upload: done.name, ...done.file, contentType: done.contentType }
    for (const [name, entry] of Object.entries(triggers)) {
      if (entry.upload !== done.name) continue
      runtime
        .invoke(app.target.project, { kind: 'trigger', name, manual: false, branch: app.target.branch, payload, ...(caller && { caller }) })
        .catch((err: unknown) => console.error(`The upload trigger ${name} of ${app.target.project} failed to start`, err))
    }
  }

  // Uploads into the hob's files: <app origin>/_hobwork/uploads[/<id>] in
  // chunks from the app, and <app origin>/_hobwork/files/<path> in one
  // request, from the app or from a script with an upload token.
  async function upload(req: IncomingMessage, res: ServerResponse, app: Resolved, url: URL) {
    const { pathname } = url
    if (!runtime) return sendJson(res, 503, { error: 'This Hobwork host does not run hob apps' }, frameHeaders)
    const header = req.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined
    let target: Omit<UploadTarget, 'uploads'>
    let caller: Caller | undefined
    if (bearer !== undefined && isUploadToken(bearer)) {
      // A bearer token is never sent by the browser on its own, so it needs no CSRF check.
      const name = app.target.branch === undefined ? uploadOfToken(host, app.project.id, bearer) : undefined
      if (!name) return sendJson(res, 401, { error: 'This upload token is not valid. Ask for a new one on the hob\'s page in Hobwork' }, frameHeaders)
      target = { project: app.target.project, projectId: app.project.id, uploader: { token: name } }
    } else {
      const cross = await crossApp(req, app, pathname)
      if (cross.error) return sendJson(res, 403, { error: cross.error }, frameHeaders)
      const session = appUser(req, app)
      if (!session) return sendJson(res, 401, { error: 'Sign in to continue' }, frameHeaders)
      const error = csrfError(req, app, cross.listed)
      if (error) return sendJson(res, 403, { error }, frameHeaders)
      if (session.deviceId !== null) markDeviceActive(host.db, session.deviceId)
      caller = callerOf(session)
      target = { project: app.target.project, projectId: app.project.id, branch: app.target.branch, uploader: { userId: session.user.id } }
    }
    try {
      const full: UploadTarget = { ...target, uploads: (await runtime.uploads(app.target.project, app.target.branch)).uploads }
      const finish = async (done: Completed) => {
        await uploadTriggers(app, done, caller)
        sendJson(res, 201, { done: true, file: done.file }, frameHeaders)
      }
      if (pathname.startsWith(`${UPLOAD_FILES_PATH}/`)) {
        if (req.method !== 'PUT') throw new HttpError(405, 'Send the file with PUT')
        const path = decodeFilePath(pathname.slice(UPLOAD_FILES_PATH.length + 1))
        if (path === undefined) throw new HttpError(400, 'This is not a valid file path')
        return await finish(await uploads.single(full, path, req))
      }
      const id = pathname.slice(UPLOADS_PATH.length + 1)
      if (!id) {
        if (req.method !== 'POST') throw new HttpError(405, 'Start an upload with POST')
        return sendJson(res, 201, await uploads.start(full, await readJson(req)), frameHeaders)
      }
      if (id.includes('/')) throw new HttpError(404, 'Not found')
      if (req.method === 'GET') return sendJson(res, 200, uploads.status(full, id), frameHeaders)
      if (req.method === 'DELETE') {
        await uploads.cancel(full, id)
        res.writeHead(204, frameHeaders)
        return res.end()
      }
      if (req.method !== 'PUT') throw new HttpError(405, 'Send parts of an upload with PUT')
      const offset = Number(url.searchParams.get('offset'))
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'offset must say where this part starts')
      const result = await uploads.chunk(full, id, offset, req)
      if ('file' in result) return await finish(result)
      return sendJson(res, 200, result, frameHeaders)
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      // An answer before the body was read: the client may still be sending it.
      if (!req.complete) res.setHeader('connection', 'close')
      return sendJson(res, err.status, { error: err.message }, frameHeaders)
    }
  }

  // Webhook URLs live in other systems, so the old name of a renamed hob still works.
  function renamedApp(hostHeader: string | undefined) {
    const label = origins.labelOf(hostHeader)
    if (!label || parseLabel(label).branchLabel !== undefined) return undefined
    const project = renamedProject(host, label)
    return project && resolve({ project: project.name })
  }

  async function serveApp(req: IncomingMessage, res: ServerResponse) {
    const app = await resolveHost(req.headers.host)
    const hookPath = new URL(req.url ?? '/', 'http://localhost')
    if (!app && hookPath.pathname.startsWith(HOOKS_PREFIX)) {
      const renamed = await renamedApp(req.headers.host)
      if (renamed) return webhook(req, res, renamed, hookPath.pathname, hookPath.search)
    }
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
    if (pathname === SHARE_PATH) return share(req, res, app, url.searchParams)
    if (pathname.startsWith(HOOKS_PREFIX)) return webhook(req, res, app, pathname, search)
    if (pathname === UPLOADS_PATH || pathname.startsWith(`${UPLOADS_PATH}/`) || pathname.startsWith(`${UPLOAD_FILES_PATH}/`)) {
      return upload(req, res, app, url)
    }
    if (pathname.startsWith(THEME_PREFIX) && options.serveTheme(req, res, pathname)) return
    if (pathname === MANIFEST_PATH || pathname.startsWith(ICONS_PREFIX)) return serveIcons(req, res, app, pathname)
    const mount = pathname.startsWith(API_PREFIX) || pathname.startsWith(RESERVED_PREFIX) ? undefined : await staticMountOf(app, pathname)
    // Public files are for anyone with the link, from any site.
    if (mount?.public) return serveStatic(req, res, app, mount, pathname)
    const cross = await crossApp(req, app, pathname)
    if (cross.error) return sendJson(res, 403, { error: cross.error }, frameHeaders)
    const viewer = viewerOf(req, app, pathname)
    const page = !pathname.startsWith(API_PREFIX) && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
    if (viewer === 'expired') {
      // The sign-in pages refuse to be framed, so a framed link says why it stopped.
      if (page) return sendText(res, 401, EXPIRED_LINK, sharedFrameHeaders)
      return sendJson(res, 401, { error: EXPIRED_LINK }, sharedFrameHeaders)
    }
    if (!viewer) {
      if (page) return redirect(res, signInUrl(app, `${app.origin}${pathname}${search}`), frameHeaders)
      return sendJson(res, 401, { error: 'Sign in to continue' }, frameHeaders)
    }
    if (!viewer.shared && viewer.session.deviceId !== null) markDeviceActive(host.db, viewer.session.deviceId)
    const frameAncestors = viewer.shared ? '*' : publicUrl
    const headers = viewer.shared ? sharedFrameHeaders : frameHeaders
    if (pathname.startsWith(API_PREFIX)) {
      if (viewer.shared && viewer.readOnly && !READ_METHODS.has(req.method ?? 'GET')) {
        return sendJson(res, 403, { error: 'This link can only read from the app' }, headers)
      }
      // A bearer token is never sent by the browser on its own, so it needs no CSRF check.
      const error = viewer.shared && viewer.bearer ? undefined : csrfError(req, app, cross.listed)
      if (error) return sendJson(res, 403, { error }, headers)
      if (!runtime) return sendJson(res, 503, { error: 'This Hobwork host does not run handlers' }, headers)
      return serveRoute(req, res, runtime, {
        project: app.target.project,
        branch: app.target.branch,
        path: pathname.slice(API_PREFIX.length - 1),
        url: url.href,
        headers: uiHeaders(frameAncestors, await cspOf(app)),
        caller: viewer.shared ? undefined : callerOf(viewer.session),
      })
    }
    if (pathname.startsWith(RESERVED_PREFIX)) return sendText(res, 404, 'Not found', headers)
    if (mount) return serveStatic(req, res, app, mount, pathname)
    await serveUi(req, res, app, pathname, frameAncestors)
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
