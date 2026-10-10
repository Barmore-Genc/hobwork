import { randomUUID } from 'node:crypto'
import type { DeviceDelivery } from '../../../packages/sdk/src/devices.ts'
import type { Caller } from '../../../packages/sdk/src/people.ts'
import type { WidgetContent, WidgetLine } from '../../../packages/sdk/src/widgets.ts'
import type { Host } from '../host.ts'
import { personOf } from '../people.ts'
import { listProjects } from '../projects.ts'
import type { IncomingMessage } from 'node:http'
import type { ShareRequest } from '../../../packages/sdk/src/share-targets.ts'
import { uploadTypeAllowed, type UploadStatus, type UploadedFile } from '../../../packages/sdk/src/uploads.ts'
import { linkRules } from '../apps/app-links.ts'
import { HttpError } from '../http.ts'
import { getProject } from '../projects.ts'
import type { AppLinks, IntentEntry, ShareEntry, UploadEntry } from '../runtime/config.ts'
import type { StaticMount } from '../runtime/files.ts'
import type { Completed, UploadTarget, Uploads } from '../runtime/uploads.ts'
import type { PushSender } from './push/relay.ts'
import { DeviceError, type DeviceRegistry } from './registry.ts'
import { setPush, type Device } from './store.ts'

// Widgets, Shortcuts actions, controls and share targets in the app, which
// hobs declare in hobwork.json ("widget", "intents", "share"), and the rules
// for which of their links open the app ("appLinks").

export const WIDGETS_CAPABILITY = 'widgets'
const DEFAULT_REFRESH_MS = 30 * 60 * 1000
const MIN_REFRESH_MS = 5 * 60 * 1000
const MAX_REFRESH_MS = 24 * 60 * 60 * 1000
const MAX_SAY = 1000
const MAX_TEXT_PARAMETER = 1000
const COLOR = /^#[0-9A-Fa-f]{6}$/
const PATH = /^\/[^\s#]{0,511}$/
const RELOAD_WAIT_MS = 4_000
const RELOAD_TTL_S = 60 * 60
const MAX_SHARED_TEXT = 100_000
const MAX_SHARED_URL = 8192
const MAX_SHARED_FILES = 20
const MAX_FILE_NAME = 255
const TRANSPORT_ERRORS = new Set(['not_connected', 'disconnected', 'timeout'])

export type Declarations = {
  widget?: string
  intents: IntentEntry[]
  share?: ShareEntry[]
  uploads?: Record<string, UploadEntry>
  appLinks?: AppLinks
  static?: StaticMount[]
}

export type RouteAnswer = { status: number; body: unknown }

export class SurfaceError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function colors(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const valid = value.filter((c): c is string => typeof c === 'string' && COLOR.test(c)).slice(0, max)
  return valid.length ? valid : undefined
}

function openPath(value: unknown): string | undefined {
  return typeof value === 'string' && PATH.test(value) ? value : undefined
}

// What a widget route returned, cut to what widgets show. Fields that are
// wrong are left out rather than failing the widget; only a missing title
// fails, so the hob's log says what to fix.
export function widgetContent(body: unknown, now: number): WidgetContent & { refreshAt: string } {
  if (!isObject(body)) throw new SurfaceError(502, 'bad_widget', 'The widget route must return a JSON object with a title')
  const title = text(body.title, 64)
  if (!title) throw new SurfaceError(502, 'bad_widget', 'The widget route must return a title')
  const lines: WidgetLine[] = (Array.isArray(body.lines) ? body.lines : [])
    .filter(isObject)
    .slice(0, 6)
    .flatMap((line) => {
      const lineText = text(line.text, 80)
      if (!lineText) return []
      const detail = text(line.detail, 40)
      const swatches = colors(line.swatches, 4)
      return [{ text: lineText, ...(detail ? { detail } : {}), ...(swatches ? { swatches } : {}) }]
    })
  const subtitle = text(body.subtitle, 120)
  const swatches = colors(body.swatches, 8)
  const open = openPath(body.open)
  const asked = typeof body.refreshAt === 'string' ? Date.parse(body.refreshAt) : NaN
  const refreshAt = Number.isNaN(asked) ? now + DEFAULT_REFRESH_MS : Math.min(Math.max(asked, now + MIN_REFRESH_MS), now + MAX_REFRESH_MS)
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(lines.length ? { lines } : {}),
    ...(swatches ? { swatches } : {}),
    ...(open ? { open } : {}),
    refreshAt: new Date(refreshAt).toISOString(),
  }
}

export function intentParameters(intent: IntentEntry, given: unknown): Record<string, string | number | boolean> {
  const values = isObject(given) ? given : {}
  const out: Record<string, string | number | boolean> = {}
  for (const parameter of intent.parameters) {
    const value = values[parameter.id]
    if (value === undefined || value === null || value === '') {
      if (!parameter.optional) throw new SurfaceError(400, 'bad_request', `${parameter.title} is required`)
      continue
    }
    const ok =
      parameter.type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : parameter.type === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' && value.length <= MAX_TEXT_PARAMETER
    if (!ok) throw new SurfaceError(400, 'bad_request', `${parameter.title} must be ${parameter.type === 'text' ? 'text' : `a ${parameter.type}`}`)
    out[parameter.id] = value as string | number | boolean
  }
  return out
}

export type HobSurfacesDeps = {
  host: Host
  registry: DeviceRegistry
  relay?: PushSender
  now: () => number
  declarations?: (project: string) => Promise<Declarations>
  callRoute?: (project: string, request: { method: string; path: string; body?: unknown }, caller: Caller) => Promise<RouteAnswer>
  projectLog: (project: string, level: 'info' | 'warn', message: string) => void
  reloadWaitMs?: number
  // Shared files go into the hob's uploads, like files.upload from the hob's app.
  uploads?: Uploads
  // Runs the upload's triggers once a shared file is in.
  uploaded?: (project: string, done: Completed, caller: Caller) => Promise<void>
}

export type HobSurfaces = ReturnType<typeof createHobSurfaces>

export function createHobSurfaces(deps: HobSurfacesDeps) {
  const { host, registry, relay, now } = deps

  function callerOf(device: Device): Caller {
    return {
      person: personOf(host.db, { id: device.userId, name: device.owner, email: device.ownerEmail }),
      device: { name: device.name, platform: device.platform },
    }
  }

  async function declared(project: string): Promise<Declarations | undefined> {
    try {
      return await deps.declarations?.(project)
    } catch {
      // Hobs that were never deployed declare nothing.
      return undefined
    }
  }

  // Every deployed hob: the app needs the link rules of each.
  async function hobs() {
    const out = []
    for (const { name } of listProjects(host)) {
      const found = await declared(name)
      if (!found) continue
      out.push({
        hob: name,
        widget: found.widget !== undefined,
        intents: found.intents.map((i) => ({
          id: i.id,
          title: i.title,
          parameters: i.parameters,
          opensApp: i.opensApp,
          ...(i.open !== undefined ? { open: i.open } : {}),
          runs: i.route !== undefined,
        })),
        share: (found.share ?? []).map((t) => {
          const upload = t.upload === undefined ? undefined : found.uploads?.[t.upload]
          return {
            id: t.id,
            title: t.title,
            accepts: { urls: t.accepts.urls, text: t.accepts.text, files: upload ? t.accepts.files : [] },
            ...(upload ? { maxBytes: upload.maxBytes } : {}),
          }
        }),
        appLinks: linkRules(found.appLinks, found.static ?? []),
      })
    }
    return out
  }

  async function route(project: string, device: Device, request: { method: string; path: string; body?: unknown }, what: string): Promise<unknown> {
    if (!deps.callRoute) throw new SurfaceError(503, 'unavailable', 'This Hobwork host runs no handlers')
    let answer: RouteAnswer
    try {
      answer = await deps.callRoute(project, request, callerOf(device))
    } catch (err) {
      deps.projectLog(project, 'warn', `${device.name}: ${what}: ${request.method} ${request.path} failed: ${(err as Error).message}`)
      throw new SurfaceError(502, 'route_failed', `The hob could not answer: ${(err as Error).message}`)
    }
    if (answer.status >= 400) {
      deps.projectLog(project, 'warn', `${device.name}: ${what}: ${request.method} ${request.path} answered ${answer.status}`)
      throw new SurfaceError(502, 'route_failed', `The hob answered ${answer.status}`)
    }
    return answer.body
  }

  async function widget(device: Device, project: string) {
    const found = await declared(project)
    if (!found?.widget) throw new SurfaceError(404, 'no_widget', `Hob ${JSON.stringify(project)} has no widget`)
    const body = await route(project, device, { method: 'GET', path: found.widget }, 'widget')
    try {
      return widgetContent(body, now())
    } catch (err) {
      if (err instanceof SurfaceError) deps.projectLog(project, 'warn', `${device.name}: widget: ${err.message}`)
      throw err
    }
  }

  async function runIntent(device: Device, request: { hob: unknown; intent: unknown; parameters?: unknown }): Promise<{ say?: string; open?: string }> {
    const { hob, intent: id } = request
    if (typeof hob !== 'string' || typeof id !== 'string') throw new SurfaceError(400, 'bad_request', 'Send { hob, intent, parameters? }')
    const found = await declared(hob)
    const intent = found?.intents.find((i) => i.id === id)
    if (!intent) throw new SurfaceError(404, 'unknown_intent', `Hob ${JSON.stringify(hob)} has no action ${JSON.stringify(id)}`)
    const parameters = intentParameters(intent, request.parameters)
    if (intent.route === undefined) return intent.open !== undefined ? { open: intent.open } : {}
    const body = await route(
      hob,
      device,
      { method: intent.method, path: intent.route, ...(intent.method === 'GET' ? {} : { body: { intent: intent.id, parameters } }) },
      `action "${intent.id}"`,
    )
    const answer = isObject(body) ? body : {}
    const say = text(answer.say, MAX_SAY)
    const open = openPath(answer.open) ?? (intent.opensApp ? (intent.open ?? '/') : undefined)
    return { ...(say ? { say } : {}), ...(open ? { open } : {}) }
  }

  // Over the socket when the app is open, else a background push, which iOS
  // may delay or drop.
  async function reloadOn(device: Device): Promise<'app' | 'push'> {
    if (registry.connected(device.id)) {
      try {
        await registry.call(device.id, WIDGETS_CAPABILITY, 'reload', {}, deps.reloadWaitMs ?? RELOAD_WAIT_MS)
        return 'app'
      } catch (err) {
        if (!(err instanceof DeviceError) || !TRANSPORT_ERRORS.has(err.code)) throw err
      }
    }
    if (!relay) throw new DeviceError('unreachable', `${device.name} is not connected, and this Hobwork host does not send push notifications`)
    if (!device.push) throw new DeviceError('unreachable', `${device.name} is not connected, and it has not registered for push notifications`)
    let result
    try {
      result = await relay.send(device.push, {
        id: randomUUID(),
        kind: 'background',
        payload: { aps: { 'content-available': 1 }, hobwork: { reloadWidgets: true } },
        expiresAt: Math.floor(now() / 1000) + RELOAD_TTL_S,
      })
    } catch (err) {
      throw new DeviceError('push_failed', `Could not reach the push relay for ${device.name}: ${(err as Error).message}`)
    }
    if (!result.ok) {
      if (result.gone) setPush(host.db, device.id, null)
      throw new DeviceError('push_failed', `The push relay refused the push for ${device.name}: ${result.reason}`)
    }
    return 'push'
  }

  async function reload(devices: Device[]): Promise<{ devices: DeviceDelivery[] }> {
    const usable = devices.filter((d) => d.capabilities.includes(WIDGETS_CAPABILITY))
    return {
      devices: await Promise.all(
        usable.map(async (device): Promise<DeviceDelivery> => {
          try {
            return { device: device.name, delivery: await reloadOn(device) }
          } catch (err) {
            const error = err instanceof DeviceError ? err : new DeviceError('device_error', (err as Error).message)
            return { device: device.name, error: { code: error.code, message: error.message } }
          }
        }),
      ),
    }
  }

  async function shareTarget(project: unknown, id: unknown): Promise<{ hob: string; target: ShareEntry; found: Declarations }> {
    if (typeof project !== 'string' || typeof id !== 'string') throw new SurfaceError(400, 'bad_request', 'Send hob and target')
    const found = await declared(project)
    const target = found?.share?.find((t) => t.id === id)
    if (!found || !target) throw new SurfaceError(404, 'unknown_target', `Hob ${JSON.stringify(project)} has no share target ${JSON.stringify(id)}`)
    return { hob: project, target, found }
  }

  // The upload a share target's files go into, as the device's owner, on the
  // deployed version. Only the target's own upload, so a device reaches none
  // of the hob's other upload folders.
  async function uploadTarget(device: Device, project: unknown, id: unknown): Promise<{ hob: string; upload: UploadTarget; entry: UploadEntry; target: ShareEntry }> {
    if (!deps.uploads) throw new SurfaceError(503, 'unavailable', 'This Hobwork host takes no uploads')
    const { hob, target, found } = await shareTarget(project, id)
    const name = target.upload
    const entry = name === undefined ? undefined : found.uploads?.[name]
    if (name === undefined || !entry || !target.accepts.files.length) throw new SurfaceError(400, 'not_accepted', `${target.title} takes no files`)
    const projectId = getProject(host, hob)?.id
    if (projectId === undefined) throw new SurfaceError(404, 'unknown_target', `There is no hob ${JSON.stringify(hob)}`)
    const upload: UploadTarget = { project: hob, projectId, uploads: { [name]: entry }, uploader: { userId: device.userId } }
    return { hob, upload, entry, target }
  }

  function uploadFailed(err: unknown): never {
    if (err instanceof HttpError) throw new SurfaceError(err.status, 'upload_failed', err.message)
    throw err
  }

  function uploads(): Uploads {
    if (!deps.uploads) throw new SurfaceError(503, 'unavailable', 'This Hobwork host takes no uploads')
    return deps.uploads
  }

  // { hob, target, name, size, type? }: the host picks a free path for the
  // file in the target's upload folder.
  async function startUpload(device: Device, body: Record<string, unknown>): Promise<UploadStatus> {
    const { upload, entry, target } = await uploadTarget(device, body.hob, body.target)
    if (typeof body.name !== 'string' || !body.name || body.name.length > MAX_FILE_NAME) {
      throw new SurfaceError(400, 'bad_request', 'Send name, the name of the file')
    }
    const type = typeof body.type === 'string' && body.type ? body.type : null
    if (!uploadTypeAllowed(target.accepts.files, body.name, type)) {
      throw new SurfaceError(415, 'not_accepted', `${target.title} takes only ${target.accepts.files.join(', ')} files`)
    }
    const path = await uploads().freePath(upload, entry.prefix, body.name)
    return uploads()
      .start(upload, { path, size: body.size, ...(type ? { type } : {}) })
      .catch(uploadFailed)
  }

  async function uploadStatus(device: Device, hob: string, target: string, id: string): Promise<UploadStatus> {
    const { upload } = await uploadTarget(device, hob, target)
    try {
      return uploads().status(upload, id)
    } catch (err) {
      uploadFailed(err)
    }
  }

  async function uploadChunk(
    device: Device,
    hob: string,
    target: string,
    id: string,
    offset: number,
    req: IncomingMessage,
  ): Promise<UploadStatus | { done: true; file: UploadedFile }> {
    const { upload } = await uploadTarget(device, hob, target)
    const result = await uploads().chunk(upload, id, offset, req).catch(uploadFailed)
    if (!('file' in result)) return result
    await deps.uploaded?.(hob, result, callerOf(device)).catch((err: unknown) => {
      deps.projectLog(hob, 'warn', `${device.name}: the triggers of the upload "${result.name}" failed to start: ${(err as Error).message}`)
    })
    return { done: true, file: result.file }
  }

  async function cancelUpload(device: Device, hob: string, target: string, id: string): Promise<void> {
    const { upload } = await uploadTarget(device, hob, target)
    await uploads().cancel(upload, id).catch(uploadFailed)
  }

  // { hob, target, url?, text?, files? }. Files were uploaded first, and each
  // must be a file in the target's upload folder.
  async function runShare(device: Device, body: Record<string, unknown>): Promise<{ say?: string; open?: string }> {
    const { hob, target } = await shareTarget(body.hob, body.target)
    const request: ShareRequest = { target: target.id, files: [] }
    if (body.url !== undefined && body.url !== null) {
      if (!target.accepts.urls) throw new SurfaceError(400, 'not_accepted', `${target.title} takes no links`)
      if (typeof body.url !== 'string' || body.url.length > MAX_SHARED_URL || !/^https?:\/\//i.test(body.url) || !URL.canParse(body.url)) {
        throw new SurfaceError(400, 'bad_request', 'url must be an http or https link')
      }
      request.url = body.url
    }
    if (body.text !== undefined && body.text !== null) {
      if (!target.accepts.text) throw new SurfaceError(400, 'not_accepted', `${target.title} takes no text`)
      if (typeof body.text !== 'string' || body.text.length > MAX_SHARED_TEXT) {
        throw new SurfaceError(400, 'bad_request', 'text must be at most 100,000 characters')
      }
      request.text = body.text
    }
    const files = Array.isArray(body.files) ? body.files : []
    if (files.length > MAX_SHARED_FILES) throw new SurfaceError(400, 'bad_request', `Share at most ${MAX_SHARED_FILES} files at once`)
    if (files.length) {
      const { upload, entry } = await uploadTarget(device, hob, target.id)
      for (const file of files) {
        if (!isObject(file) || typeof file.path !== 'string' || !file.path.startsWith(entry.prefix)) {
          throw new SurfaceError(400, 'bad_request', `files must be files uploaded to ${target.title}`)
        }
        const stat = await uploads().stat(upload, file.path).catch(uploadFailed)
        if (!stat) throw new SurfaceError(400, 'bad_request', `${file.path} has not been uploaded`)
        const name = typeof file.name === 'string' && file.name && file.name.length <= MAX_FILE_NAME ? file.name : file.path.slice(file.path.lastIndexOf('/') + 1)
        const contentType = typeof file.contentType === 'string' && file.contentType && file.contentType.length <= 200 ? file.contentType : null
        request.files.push({ path: file.path, name, size: stat.size, contentType })
      }
    }
    if (request.url === undefined && request.text === undefined && !request.files.length) {
      throw new SurfaceError(400, 'bad_request', 'Share a link, text or files')
    }
    const answer = await route(hob, device, { method: 'POST', path: target.route, body: request }, `share "${target.id}"`)
    const result = isObject(answer) ? answer : {}
    const say = text(result.say, MAX_SAY)
    const open = openPath(result.open)
    return { ...(say ? { say } : {}), ...(open ? { open } : {}) }
  }

  return { hobs, widget, runIntent, reload, startUpload, uploadStatus, uploadChunk, cancelUpload, runShare }
}
