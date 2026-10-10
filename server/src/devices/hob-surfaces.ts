import { randomUUID } from 'node:crypto'
import type { DeviceDelivery } from '../../../packages/sdk/src/devices.ts'
import type { Caller } from '../../../packages/sdk/src/people.ts'
import type { WidgetContent, WidgetLine } from '../../../packages/sdk/src/widgets.ts'
import type { Host } from '../host.ts'
import { personOf } from '../people.ts'
import { listProjects } from '../projects.ts'
import type { IntentEntry } from '../runtime/config.ts'
import type { PushSender } from './push/relay.ts'
import { DeviceError, type DeviceRegistry } from './registry.ts'
import { setPush, type Device } from './store.ts'

// Widgets, Shortcuts actions and controls in the app, which hobs declare in
// hobwork.json ("widget", "intents").

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
const TRANSPORT_ERRORS = new Set(['not_connected', 'disconnected', 'timeout'])

export type Declarations = { widget?: string; intents: IntentEntry[] }

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

  async function hobs() {
    const out = []
    for (const { name } of listProjects(host)) {
      const found = await declared(name)
      if (!found || (!found.widget && !found.intents.length)) continue
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

  return { hobs, widget, runIntent, reload }
}
