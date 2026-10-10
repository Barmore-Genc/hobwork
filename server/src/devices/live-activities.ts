import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { LiveActivityDelivery } from '../../../packages/sdk/src/live-activities.ts'
import type { Caller } from '../../../packages/sdk/src/people.ts'
import type { Host } from '../host.ts'
import { personOf } from '../people.ts'
import { getProject } from '../projects.ts'
import { liveActivitySize, MAX_PAYLOAD_BYTES, PayloadTooLarge, type LiveActivityEvent, type PushSender } from './push/relay.ts'
import { DeviceError, type DeviceRegistry } from './registry.ts'
import { getDevice, setLiveActivityStartToken, type Device } from './store.ts'

export const CAPABILITY = 'liveActivities'
// iOS ends an activity 8 hours after it started. Restarting a quarter of an
// hour before leaves room for a push that is late or fails once.
export const LIMIT_MS = 8 * 60 * 60 * 1000
export const RESTART_AFTER_MS = LIMIT_MS - 15 * 60 * 1000
// Progress-only changes go by push at most this often, unless they moved by
// PROGRESS_STEP, to stay inside iOS's budget for Live Activity pushes.
export const PUSH_INTERVAL_MS = 5 * 60 * 1000
export const PROGRESS_STEP = 0.02
export const SOCKET_WAIT_MS = 10_000
const ENDED_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_DATA_BYTES = 4096
const MAX_PATH = 512
const KEY = /^[A-Za-z0-9_.:-]{1,64}$/
const PATH = /^\/[^\s#]*$/
const COLOR = /^#[0-9A-Fa-f]{6}$/
const SYMBOL = /^[a-z0-9.]{1,64}$/
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const PAST_LIMIT = ['restart', 'stillRunning'] as const
const CONTENT_FIELDS = [
  'title',
  'subtitle',
  'swatches',
  'icon',
  'tint',
  'endsAt',
  'startedAt',
  'progress',
  'value',
  'valueLabel',
  'button',
  'open',
  'data',
  'staleAt',
  'relevance',
] as const
// Transport failures that push can make up for.
const TRANSPORT_ERRORS = new Set(['not_connected', 'disconnected', 'timeout'])
const SAMPLE_ID = '00000000-0000-0000-0000-000000000000'

type PastLimit = (typeof PAST_LIMIT)[number]

export type Button = { title: string; route: string; method?: string; body?: unknown; opensApp?: boolean }

// As the hob sent it, dates as ISO strings.
export type Content = {
  title: string
  subtitle?: string
  swatches?: string[]
  icon?: string
  tint?: string
  endsAt?: string
  startedAt?: string
  progress?: number
  value?: string
  valueLabel?: string
  button?: Button
  open?: string
  data?: unknown
  staleAt?: string
  relevance?: number
}

// What devices get: HobworkActivityAttributes.ContentState in the app.
export type DeviceState = {
  title: string
  subtitle?: string
  swatches?: string[]
  icon?: string
  tint?: string
  endsAt?: number
  startedAt?: number
  progress?: number
  value?: string
  valueLabel?: string
  button?: { title: string; opensApp?: true }
  open?: string
  stillRunning?: true
}

export type Scope = 'all' | { person: number } | { device: number }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bad(message: string): never {
  throw new DeviceError('bad_request', message)
}

function text(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) bad(`${name} must be a non-empty string of at most ${max} characters`)
  return value
}

function path(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > MAX_PATH || !PATH.test(value)) bad(`${name} must be a path starting with "/", at most ${MAX_PATH} characters`)
  return value
}

function date(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  if (Number.isNaN(ms)) bad(`${name} must be an ISO date-time, e.g. new Date(...).toISOString()`)
  return new Date(ms).toISOString()
}

function colors(value: unknown, name: string, max: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > max || !value.every((c) => typeof c === 'string' && COLOR.test(c))) {
    bad(`${name} must be a list of at most ${max} colors like "#3A7BD5"`)
  }
  return value as string[]
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '')
}

function parseButton(value: unknown): Button | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) bad('button must be an object with a title and a route')
  for (const name of Object.keys(value)) {
    if (!['title', 'route', 'method', 'body', 'opensApp'].includes(name)) bad(`button has no field ${name}`)
  }
  const { method, body, opensApp } = value
  if (method !== undefined && (typeof method !== 'string' || !METHODS.includes(method))) bad(`button.method must be one of ${METHODS.join(', ')}`)
  if (body !== undefined && method === 'GET') bad('A GET route takes no body')
  if (body !== undefined && jsonBytes(body) > MAX_DATA_BYTES) bad(`button.body must be at most ${MAX_DATA_BYTES} bytes as JSON`)
  if (opensApp !== undefined && typeof opensApp !== 'boolean') bad('button.opensApp must be true or false')
  const route = path(value.route, 'button.route')
  if (route === undefined) bad('button needs a route')
  return {
    title: text(value.title, 'button.title', 24) ?? bad('button needs a title'),
    route,
    ...(method !== undefined ? { method } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(opensApp ? { opensApp } : {}),
  }
}

export function parseContent(input: Record<string, unknown>): Content {
  const { progress, relevance, data } = input
  if (progress !== undefined && (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)) {
    bad('progress must be a number from 0 to 1')
  }
  if (relevance !== undefined && (typeof relevance !== 'number' || !Number.isFinite(relevance) || relevance < 0)) {
    bad('relevance must be a number of 0 or more')
  }
  if (data !== undefined && jsonBytes(data) > MAX_DATA_BYTES) bad(`data must be at most ${MAX_DATA_BYTES} bytes as JSON`)
  if (input.icon !== undefined && (typeof input.icon !== 'string' || !SYMBOL.test(input.icon))) bad('icon must be an SF Symbols name, e.g. "flame"')
  if (input.tint !== undefined && (typeof input.tint !== 'string' || !COLOR.test(input.tint))) bad('tint must be a color like "#3A7BD5"')
  const fields: Content = {
    title: text(input.title, 'title', 64) ?? bad('title must be a non-empty string of at most 64 characters'),
    subtitle: text(input.subtitle, 'subtitle', 120),
    swatches: colors(input.swatches, 'swatches', 4),
    icon: input.icon as string | undefined,
    tint: input.tint as string | undefined,
    endsAt: date(input.endsAt, 'endsAt'),
    startedAt: date(input.startedAt, 'startedAt'),
    progress: progress as number | undefined,
    value: text(input.value, 'value', 16),
    valueLabel: text(input.valueLabel, 'valueLabel', 32),
    button: parseButton(input.button),
    open: path(input.open, 'open'),
    data,
    staleAt: date(input.staleAt, 'staleAt'),
    relevance: relevance as number | undefined,
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Content
}

function onlyContent(input: Record<string, unknown>, extra: string[]) {
  for (const name of Object.keys(input)) {
    if (!(CONTENT_FIELDS as readonly string[]).includes(name) && !extra.includes(name)) bad(`A Live Activity has no field ${name}`)
  }
}

export type ParsedStart = { key: string; content: Content; pastLimit: PastLimit; devices: 'all' | 'lastActive' }

export function parseStart(args: unknown, options: { person?: boolean } = {}): ParsedStart {
  if (!isObject(args)) bad('The Live Activity must be an object with an id and a title')
  onlyContent(args, ['id', 'pastLimit', 'devices'])
  const { id, pastLimit, devices, ...content } = args
  if (typeof id !== 'string' || !KEY.test(id)) bad('id must be letters, digits and "-_.:", at most 64')
  if (pastLimit !== undefined && !(PAST_LIMIT as readonly unknown[]).includes(pastLimit)) bad('pastLimit must be "restart" or "stillRunning"')
  if (devices !== undefined && (!options.person || (devices !== 'all' && devices !== 'lastActive'))) {
    bad(options.person ? 'devices must be "all" or "lastActive"' : 'devices only works with ctx.person(id).liveActivities')
  }
  return {
    key: id,
    content: parseContent(content),
    pastLimit: (pastLimit as PastLimit | undefined) ?? 'restart',
    devices: (devices as 'all' | 'lastActive' | undefined) ?? 'all',
  }
}

// Changes merge into the content; null removes a field.
export function applyChanges(content: Content, changes: unknown): Content {
  if (!isObject(changes)) bad('The changes must be an object')
  onlyContent(changes, [])
  const merged: Record<string, unknown> = { ...content }
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) delete merged[name]
    else if (value !== undefined) merged[name] = value
  }
  return parseContent(merged)
}

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000)

export function deviceState(content: Content, stillRunning: boolean): DeviceState {
  const { title, subtitle, swatches, icon, tint, endsAt, startedAt, progress, value, valueLabel, button, open } = content
  return {
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(swatches?.length ? { swatches } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(tint !== undefined ? { tint } : {}),
    ...(endsAt !== undefined ? { endsAt: seconds(endsAt) } : {}),
    ...(startedAt !== undefined ? { startedAt: seconds(startedAt) } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(valueLabel !== undefined ? { valueLabel } : {}),
    ...(button ? { button: { title: button.title, ...(button.opensApp ? { opensApp: true as const } : {}) } } : {}),
    ...(open !== undefined ? { open } : {}),
    ...(stillRunning ? { stillRunning: true as const } : {}),
  }
}

// A change of anything but progress shows at once; progress can wait.
function onlyProgressChanged(before: DeviceState, after: DeviceState): boolean {
  const { progress: _a, ...restBefore } = before
  const { progress: _b, ...restAfter } = after
  return JSON.stringify(restBefore) === JSON.stringify(restAfter)
}

// Store

const iso = (ms: number) => new Date(ms).toISOString()

export type ActivityRow = {
  id: string
  projectId: number
  project: string
  key: string
  content: Content
  pastLimit: PastLimit
  revision: number
  endedAt: string | null
}

export type DeviceRowState = 'starting' | 'active' | 'dismissed' | 'ended'

export type DeviceRow = {
  activityId: string
  deviceId: number
  state: DeviceRowState
  activity: string | null
  token: string | null
  startedAt: number
  sentRevision: number
  sentAt: number | null
  sentState: DeviceState | null
  stillRunning: boolean
}

const SELECT_ACTIVITY = 'SELECT a.*, p.name AS project FROM live_activities a JOIN projects p ON p.id = a.project_id'

function toActivity(row: Record<string, unknown>): ActivityRow {
  return {
    id: String(row.id),
    projectId: Number(row.project_id),
    project: String(row.project),
    key: String(row.key),
    content: JSON.parse(String(row.content)) as Content,
    pastLimit: String(row.past_limit) as PastLimit,
    revision: Number(row.revision),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
  }
}

function toDeviceRow(row: Record<string, unknown>): DeviceRow {
  return {
    activityId: String(row.activity_id),
    deviceId: Number(row.device_id),
    state: String(row.state) as DeviceRowState,
    activity: row.activity === null ? null : String(row.activity),
    token: row.token === null ? null : String(row.token),
    startedAt: Date.parse(String(row.started_at)),
    sentRevision: Number(row.sent_revision),
    sentAt: row.sent_at === null ? null : Date.parse(String(row.sent_at)),
    sentState: row.sent_state === null ? null : (JSON.parse(String(row.sent_state)) as DeviceState),
    stillRunning: Number(row.still_running) === 1,
  }
}

export function getActivity(db: DatabaseSync, id: string): ActivityRow | undefined {
  const row = db.prepare(`${SELECT_ACTIVITY} WHERE a.id = ?`).get(id)
  return row ? toActivity(row) : undefined
}

export function activityByKey(db: DatabaseSync, projectId: number, key: string): ActivityRow | undefined {
  const row = db.prepare(`${SELECT_ACTIVITY} WHERE a.project_id = ? AND a.key = ?`).get(projectId, key)
  return row ? toActivity(row) : undefined
}

// A start with a key that runs replaces its content; one whose activity ended
// is a new run, with a new ID, so reports about the old one cannot touch it.
function saveStart(db: DatabaseSync, projectId: number, parsed: ParsedStart, now: number): ActivityRow {
  const current = activityByKey(db, projectId, parsed.key)
  if (current && current.endedAt === null) {
    db.prepare('UPDATE live_activities SET content = ?, past_limit = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(
      JSON.stringify(parsed.content),
      parsed.pastLimit,
      iso(now),
      current.id,
    )
    return getActivity(db, current.id)!
  }
  if (current) db.prepare('DELETE FROM live_activities WHERE id = ?').run(current.id)
  const id = randomUUID()
  db.prepare(
    `INSERT INTO live_activities (id, project_id, key, content, past_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, parsed.key, JSON.stringify(parsed.content), parsed.pastLimit, iso(now), iso(now))
  return getActivity(db, id)!
}

function saveContent(db: DatabaseSync, id: string, content: Content, now: number): ActivityRow {
  db.prepare('UPDATE live_activities SET content = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(content), iso(now), id)
  return getActivity(db, id)!
}

export function deviceRows(db: DatabaseSync, activityId: string): DeviceRow[] {
  return db.prepare('SELECT * FROM live_activity_devices WHERE activity_id = ? ORDER BY device_id').all(activityId).map(toDeviceRow)
}

function deviceRow(db: DatabaseSync, activityId: string, deviceId: number): DeviceRow | undefined {
  const row = db.prepare('SELECT * FROM live_activity_devices WHERE activity_id = ? AND device_id = ?').get(activityId, deviceId)
  return row ? toDeviceRow(row) : undefined
}

// The device was sent a start: the activity there is new.
function recordStart(db: DatabaseSync, row: ActivityRow, deviceId: number, state: DeviceState, activity: string | null, now: number) {
  db.prepare(
    `INSERT INTO live_activity_devices (activity_id, device_id, state, activity, token, started_at, sent_revision, sent_at, sent_state, still_running)
     VALUES (?1, ?2, 'starting', ?3, NULL, ?4, ?5, ?4, ?6, 0)
     ON CONFLICT (activity_id, device_id) DO UPDATE SET state = 'starting', activity = excluded.activity, token = NULL,
       started_at = excluded.started_at, sent_revision = excluded.sent_revision, sent_at = excluded.sent_at,
       sent_state = excluded.sent_state, still_running = 0`,
  ).run(row.id, deviceId, activity, iso(now), row.revision, JSON.stringify(state))
}

function recordSent(db: DatabaseSync, activityId: string, deviceId: number, revision: number, state: DeviceState, now: number) {
  db.prepare('UPDATE live_activity_devices SET sent_revision = ?, sent_at = ?, sent_state = ? WHERE activity_id = ? AND device_id = ?').run(
    revision,
    iso(now),
    JSON.stringify(state),
    activityId,
    deviceId,
  )
}

function setDeviceState(db: DatabaseSync, activityId: string, deviceId: number, state: DeviceRowState) {
  db.prepare('UPDATE live_activity_devices SET state = ? WHERE activity_id = ? AND device_id = ?').run(state, activityId, deviceId)
}

function forgetDeviceRow(db: DatabaseSync, activityId: string, deviceId: number) {
  db.prepare('DELETE FROM live_activity_devices WHERE activity_id = ? AND device_id = ?').run(activityId, deviceId)
}

const LIVE: DeviceRowState[] = ['starting', 'active']

// Sending

export type LiveActivitiesDeps = {
  host: Host
  registry: DeviceRegistry
  relay?: PushSender
  now: () => number
  findReachable: (name: string) => Device
  personDevices: (id: number) => Device[] | undefined
  reachable: (device: Device | undefined) => device is Device
  projectLog: (project: string, level: 'info' | 'warn', message: string) => void
  invokeRoute?: (project: string, request: { method: string; path: string; body?: unknown }, caller: Caller) => Promise<number>
  socketWaitMs?: number
}

export type LiveActivities = ReturnType<typeof createLiveActivities>

export function createLiveActivities(deps: LiveActivitiesDeps) {
  const { host, registry, relay, now } = deps
  const db = host.db
  const socketWaitMs = deps.socketWaitMs ?? SOCKET_WAIT_MS
  // ActivityKit ignores a push whose timestamp is not newer than the last one
  // it applied, and an update and an end can leave within the same second.
  let lastTimestamp = 0

  function timestamp(): number {
    lastTimestamp = Math.max(Math.floor(now() / 1000), lastTimestamp + 1)
    return lastTimestamp
  }

  function projectId(project: string): number {
    const row = getProject(host, project)
    if (!row) bad(`Hob "${project}" does not exist`)
    return row.id
  }

  function allows(device: Device): boolean {
    return device.platform === 'ios' && device.capabilities.includes(CAPABILITY)
  }

  function requireAllowed(device: Device): Device {
    if (!allows(device)) {
      throw new DeviceError(
        'unsupported',
        `${device.name} does not allow Live Activities. Live Activities need the Hobwork app on an iPhone or iPad, with Live Activities turned on for Hobwork in its settings`,
      )
    }
    return device
  }

  function personTargets(person: number, which: 'all' | 'lastActive'): Device[] {
    const owned = deps.personDevices(person)
    if (!owned) throw new DeviceError('unknown_person', `No person with ID ${JSON.stringify(person)}. ctx.people() lists them`)
    const usable = owned.filter(allows)
    if (!usable.length) throw new DeviceError('unreachable', `Person ${person} has no device that allows Live Activities`)
    return which === 'lastActive' ? usable.slice(0, 1) : usable
  }

  function inScope(scope: Scope, deviceId: number): boolean {
    if (scope === 'all') return true
    const device = getDevice(db, deviceId)
    if (!deps.reachable(device)) return false
    return 'device' in scope ? device.id === scope.device : device.userId === scope.person
  }

  // Checked before anything is sent, so every activity that is accepted can
  // also go by push.
  function checkSize(project: string, content: Content) {
    const state = deviceState(content, true)
    const size = liveActivitySize({
      activity: 'A'.repeat(22),
      event: 'start',
      priority: 10,
      timestamp: Math.floor(now() / 1000),
      staleDate: content.staleAt === undefined ? undefined : seconds(content.staleAt),
      dismissalDate: Math.floor(now() / 1000),
      relevanceScore: content.relevance,
      expiresAt: 0,
      payload: { hob: project, id: SAMPLE_ID, state },
    })
    if (size > MAX_PAYLOAD_BYTES) {
      throw new DeviceError('too_large', `The Live Activity is ${size} bytes as a push, and Apple allows ${MAX_PAYLOAD_BYTES}. Shorten its text`)
    }
  }

  function socketArgs(row: ActivityRow, state: DeviceState) {
    return {
      id: row.id,
      state,
      ...(row.content.staleAt !== undefined ? { staleAt: seconds(row.content.staleAt) } : {}),
      ...(row.content.relevance !== undefined ? { relevance: row.content.relevance } : {}),
    }
  }

  async function overSocket(device: Device, method: string, args: unknown): Promise<{ sent: true; value: unknown } | { sent: false; reason?: string }> {
    if (!registry.connected(device.id)) return { sent: false }
    try {
      return { sent: true, value: await registry.call(device.id, CAPABILITY, method, args, socketWaitMs) }
    } catch (err) {
      if (err instanceof DeviceError && TRANSPORT_ERRORS.has(err.code)) return { sent: false, reason: err.message }
      throw err
    }
  }

  async function push(
    device: Device,
    row: ActivityRow,
    options: { event: LiveActivityEvent; token: string; state: DeviceState; priority: 5 | 10; dismissalDate?: number; ttlS: number },
  ): Promise<void> {
    if (!relay) throw new DeviceError('unreachable', `${device.name} is not connected, and this Hobwork host does not send push notifications`)
    if (!device.push) throw new DeviceError('unreachable', `${device.name} is not connected, and it has not registered for push notifications`)
    let result
    try {
      result = await relay.sendLiveActivity(device.push, {
        activity: options.token,
        event: options.event,
        priority: options.priority,
        timestamp: timestamp(),
        ...(row.content.staleAt !== undefined ? { staleDate: seconds(row.content.staleAt) } : {}),
        ...(options.dismissalDate !== undefined ? { dismissalDate: options.dismissalDate } : {}),
        ...(row.content.relevance !== undefined ? { relevanceScore: row.content.relevance } : {}),
        expiresAt: Math.floor(now() / 1000) + options.ttlS,
        payload: { hob: row.project, id: row.id, state: options.state },
      })
    } catch (err) {
      if (err instanceof PayloadTooLarge) throw new DeviceError('too_large', err.message)
      throw new DeviceError('push_failed', `Could not reach the push relay for ${device.name}: ${(err as Error).message}`)
    }
    if (result.ok) return
    if (result.gone) {
      db.prepare('UPDATE devices SET push_grant = NULL, push_key = NULL WHERE id = ?').run(device.id)
      setLiveActivityStartToken(db, device.id, null)
    } else if (result.activityGone) {
      if (options.event === 'start') setLiveActivityStartToken(db, device.id, null)
      else db.prepare('UPDATE live_activity_devices SET token = NULL WHERE activity_id = ? AND device_id = ? AND token = ?').run(row.id, device.id, options.token)
    }
    throw new DeviceError('push_failed', `The push relay refused the Live Activity push for ${device.name}: ${result.reason}`)
  }

  // A new activity on the device: started by the app when it is open, else by
  // a push-to-start push. The row comes first, since the app may report the
  // activity before the call returns.
  async function startOn(device: Device, row: ActivityRow): Promise<'app' | 'push'> {
    const previous = deviceRow(db, row.id, device.id)
    const state = deviceState(row.content, false)
    recordStart(db, row, device.id, state, null, now())
    try {
      const socket = await overSocket(device, 'start', { hob: row.project, ...socketArgs(row, state) })
      if (socket.sent) {
        const activity = isObject(socket.value) && typeof socket.value.activity === 'string' ? socket.value.activity : null
        if (activity) db.prepare('UPDATE live_activity_devices SET activity = ? WHERE activity_id = ? AND device_id = ? AND activity IS NULL').run(activity, row.id, device.id)
        return 'app'
      }
      const offline = socket.reason ? `${device.name} did not answer (${socket.reason})` : `${device.name} is not connected`
      if (!device.liveActivityStartToken) {
        throw new DeviceError('unreachable', `${offline}, and its app has not allowed starting Live Activities while it is closed. Opening the Hobwork app on it once fixes that`)
      }
      await push(device, row, { event: 'start', token: device.liveActivityStartToken, state, priority: 10, ttlS: 60 * 60 })
      return 'push'
    } catch (err) {
      if (previous) {
        db.prepare(
          'UPDATE live_activity_devices SET state = ?, activity = ?, token = ?, started_at = ?, sent_revision = ?, sent_at = ?, sent_state = ?, still_running = ? WHERE activity_id = ? AND device_id = ?',
        ).run(
          previous.state,
          previous.activity,
          previous.token,
          iso(previous.startedAt),
          previous.sentRevision,
          previous.sentAt === null ? null : iso(previous.sentAt),
          previous.sentState === null ? null : JSON.stringify(previous.sentState),
          previous.stillRunning ? 1 : 0,
          row.id,
          device.id,
        )
      } else forgetDeviceRow(db, row.id, device.id)
      throw err
    }
  }

  // The latest content to a device that shows the activity. force skips the
  // wait for progress-only changes.
  async function updateOn(device: Device, row: ActivityRow, current: DeviceRow, force = false): Promise<'app' | 'push' | 'queued'> {
    const state = deviceState(row.content, current.stillRunning)
    const socket = await overSocket(device, 'update', socketArgs(row, state))
    if (socket.sent) {
      recordSent(db, row.id, device.id, row.revision, state, now())
      if (isObject(socket.value) && socket.value.updated === false && current.state === 'active') setDeviceState(db, row.id, device.id, 'ended')
      return 'app'
    }
    if (!current.token) return 'queued'
    const minor = current.sentState !== null && onlyProgressChanged(current.sentState, state)
    if (minor && !force && current.sentAt !== null && now() - current.sentAt < PUSH_INTERVAL_MS) {
      if (Math.abs((state.progress ?? 0) - (current.sentState?.progress ?? 0)) < PROGRESS_STEP) return 'queued'
    }
    await push(device, row, { event: 'update', token: current.token, state, priority: minor ? 5 : 10, ttlS: 60 * 60 })
    recordSent(db, row.id, device.id, row.revision, state, now())
    return 'push'
  }

  async function endOn(device: Device, row: ActivityRow, current: DeviceRow, dismissAt: number | undefined): Promise<'app' | 'push' | 'queued'> {
    const state = deviceState(row.content, current.stillRunning)
    setDeviceState(db, row.id, device.id, 'ended')
    const socket = await overSocket(device, 'end', { id: row.id, state, ...(dismissAt !== undefined ? { dismissAt } : {}) })
    if (socket.sent) {
      recordSent(db, row.id, device.id, row.revision, state, now())
      return 'app'
    }
    // Ended once the app reports the token (stateEvent).
    if (!current.token) return 'queued'
    await push(device, row, { event: 'end', token: current.token, state, priority: 10, dismissalDate: dismissAt, ttlS: 12 * 60 * 60 })
    recordSent(db, row.id, device.id, row.revision, state, now())
    return 'push'
  }

  async function each(rows: { device: Device; run: () => Promise<'app' | 'push' | 'queued'> }[]): Promise<LiveActivityDelivery[]> {
    return Promise.all(
      rows.map(async ({ device, run }): Promise<LiveActivityDelivery> => {
        try {
          return { device: device.name, delivery: await run() }
        } catch (err) {
          const error = err instanceof DeviceError ? err : new DeviceError('device_error', (err as Error).message)
          return { device: device.name, error: { code: error.code, message: error.message } }
        }
      }),
    )
  }

  async function startFor(project: string, parsed: ParsedStart, targets: Device[]): Promise<{ id: string; devices: LiveActivityDelivery[] }> {
    const id = projectId(project)
    checkSize(project, parsed.content)
    const row = saveStart(db, id, parsed, now())
    const results = await each(
      targets.map((device) => {
        const current = deviceRow(db, row.id, device.id)
        if (current?.state === 'dismissed') {
          return {
            device,
            run: () => Promise.reject(new DeviceError('dismissed', `${device.name} dismissed this Live Activity, so it is not shown there again until it ends`)),
          }
        }
        if (current && LIVE.includes(current.state)) return { device, run: () => updateOn(device, row, current, true) }
        return { device, run: () => startOn(device, row) }
      }),
    )
    return { id: row.key, devices: results }
  }

  function byKey(project: string, key: unknown): ActivityRow | undefined {
    if (typeof key !== 'string' || !KEY.test(key)) bad('The Live Activity ID must be letters, digits and "-_.:", at most 64')
    const row = activityByKey(db, projectId(project), key)
    return row && row.endedAt === null ? row : undefined
  }

  function liveRows(row: ActivityRow, scope: Scope): { device: Device; current: DeviceRow }[] {
    return deviceRows(db, row.id)
      .filter((d) => LIVE.includes(d.state) && inScope(scope, d.deviceId))
      .map((d) => ({ device: getDevice(db, d.deviceId), current: d }))
      .filter((d): d is { device: Device; current: DeviceRow } => deps.reachable(d.device))
  }

  async function update(project: string, key: unknown, changes: unknown, scope: Scope) {
    const current = byKey(project, key)
    if (!current) return { updated: false, devices: [] }
    const content = applyChanges(current.content, changes)
    checkSize(project, content)
    const targets = liveRows(current, scope)
    if (!targets.length) return { updated: false, devices: [] }
    const row = saveContent(db, current.id, content, now())
    const devices = await each(targets.map(({ device, current }) => ({ device, run: () => updateOn(device, row, current) })))
    return { updated: true, devices }
  }

  function parseEnd(options: unknown): { changes?: unknown; dismissAt?: number } {
    if (options === undefined || options === null) return {}
    if (!isObject(options)) bad('The options must be an object')
    for (const name of Object.keys(options)) if (!['content', 'dismissAt'].includes(name)) bad(`end takes content and dismissAt, not ${name}`)
    let dismissAt: number | undefined
    if (options.dismissAt !== undefined) {
      if (options.dismissAt === 'now') dismissAt = Math.floor(now() / 1000)
      else {
        const at = typeof options.dismissAt === 'string' ? Date.parse(options.dismissAt) : NaN
        if (Number.isNaN(at)) bad('dismissAt must be "now" or an ISO date-time')
        if (at > now() + 4 * 60 * 60 * 1000) bad('dismissAt must be within 4 hours: iOS removes ended Live Activities after that')
        dismissAt = Math.floor(Math.max(at, now()) / 1000)
      }
    }
    return { ...(options.content !== undefined ? { changes: options.content } : {}), ...(dismissAt !== undefined ? { dismissAt } : {}) }
  }

  async function end(project: string, key: unknown, options: unknown, scope: Scope) {
    let row = byKey(project, key)
    if (!row) return { ended: false, devices: [] }
    const { changes, dismissAt } = parseEnd(options)
    if (changes !== undefined) {
      const content = applyChanges(row.content, changes)
      checkSize(project, content)
      row = saveContent(db, row.id, content, now())
    }
    const targets = liveRows(row, scope)
    const ended = row
    const devices = await each(targets.map(({ device, current }) => ({ device, run: () => endOn(device, ended, current, dismissAt) })))
    if (!deviceRows(db, row.id).some((d) => LIVE.includes(d.state))) {
      db.prepare('UPDATE live_activities SET ended_at = ?, updated_at = ? WHERE id = ?').run(iso(now()), iso(now()), row.id)
    }
    return { ended: targets.length > 0, devices }
  }

  // The bridge's start from a page in the app: the app starts the activity
  // itself, so this only records it and answers what to show.
  function startHere(project: string, device: Device, args: unknown) {
    requireAllowed(device)
    const parsed = parseStart(args)
    checkSize(project, parsed.content)
    const row = saveStart(db, projectId(project), parsed, now())
    const state = deviceState(row.content, false)
    recordStart(db, row, device.id, state, null, now())
    return { id: row.key, activity: { hob: project, ...socketArgs(row, state) } }
  }

  // Events from the app

  function callerOf(device: Device): Caller {
    return {
      person: personOf(db, { id: device.userId, name: device.owner, email: device.ownerEmail }),
      device: { name: device.name, platform: device.platform },
    }
  }

  // The app reports activities it runs, their push tokens, and when the
  // person dismissed one or iOS ended it.
  async function stateEvent(device: Device, data: Record<string, unknown>): Promise<void> {
    const { id, activity, state, token } = data
    if (typeof id !== 'string' || !UUID.test(id) || typeof activity !== 'string' || !activity || activity.length > 128) return
    if (token !== undefined && (typeof token !== 'string' || !TOKEN.test(token))) return
    const current = deviceRow(db, id, device.id)
    const row = getActivity(db, id)
    if (!current || !row) return
    if (state === 'active') {
      if (current.activity !== null && current.activity !== activity) return
      db.prepare('UPDATE live_activity_devices SET activity = ?, token = coalesce(?, token) WHERE activity_id = ? AND device_id = ?').run(
        activity,
        token ?? null,
        id,
        device.id,
      )
      const next = deviceRow(db, id, device.id)!
      if (current.state === 'ended' && next.token) {
        await push(device, row, { event: 'end', token: next.token, state: deviceState(row.content, next.stillRunning), priority: 10, ttlS: 12 * 60 * 60 }).catch(
          (err: unknown) => deps.projectLog(row.project, 'warn', `Ending Live Activity ${JSON.stringify(row.key)} on ${device.name} failed: ${(err as Error).message}`),
        )
        return
      }
      if (current.state === 'starting') setDeviceState(db, id, device.id, 'active')
      if (row.revision > next.sentRevision && next.token) {
        await updateOn(device, row, { ...next, state: 'active' }, true).catch((err: unknown) =>
          deps.projectLog(row.project, 'warn', `Updating Live Activity ${JSON.stringify(row.key)} on ${device.name} failed: ${(err as Error).message}`),
        )
      }
      return
    }
    if (state !== 'dismissed' && state !== 'ended') return
    if (current.activity !== activity) return
    if (current.state === 'dismissed') return
    setDeviceState(db, id, device.id, state)
  }

  function startTokenEvent(device: Device, data: Record<string, unknown>) {
    const { token } = data
    if (token !== null && (typeof token !== 'string' || !TOKEN.test(token))) return
    setLiveActivityStartToken(db, device.id, token)
  }

  // The button: runs its route like a notification action. Resolves once the
  // route started, since iOS gives the intent a few seconds.
  function actionEvent(device: Device, data: Record<string, unknown>) {
    const { id } = data
    if (typeof id !== 'string' || !UUID.test(id)) return
    const current = deviceRow(db, id, device.id)
    const row = getActivity(db, id)
    if (!current || !row || !row.content.button) return
    const button = row.content.button
    const request = {
      method: button.method ?? 'POST',
      path: button.route,
      ...(button.method === 'GET'
        ? {}
        : { body: button.body ?? { activityId: row.key, ...(row.content.data !== undefined ? { data: row.content.data } : {}) } }),
    }
    const what = `${device.name}: button "${button.title}" on Live Activity ${JSON.stringify(row.key)}: ${request.method} ${request.path}`
    if (!deps.invokeRoute) {
      deps.projectLog(row.project, 'warn', `${what} could not run, since this Hobwork host runs no handlers`)
      return
    }
    deps
      .invokeRoute(row.project, request, callerOf(device))
      .then((status) => {
        if (status >= 400) deps.projectLog(row.project, 'warn', `${what} answered ${status}`)
      })
      .catch((err: unknown) => deps.projectLog(row.project, 'warn', `${what} failed: ${(err as Error).message}`))
  }

  // Every minute: activities near iOS's 8 hour limit restart or switch to
  // "Still running", and progress held back for the push budget goes out.
  async function tick(): Promise<void> {
    const at = now()
    db.prepare('DELETE FROM live_activities WHERE ended_at IS NOT NULL AND ended_at <= ?').run(iso(at - ENDED_RETENTION_MS))
    const rows = db
      .prepare(
        `SELECT d.* FROM live_activity_devices d JOIN live_activities a ON a.id = d.activity_id
         WHERE a.ended_at IS NULL AND d.state IN ('starting', 'active')`,
      )
      .all()
      .map(toDeviceRow)
    for (const current of rows) {
      const row = getActivity(db, current.activityId)
      const device = getDevice(db, current.deviceId)
      if (!row || !deps.reachable(device)) continue
      try {
        if (!current.stillRunning && at - current.startedAt >= RESTART_AFTER_MS) await pastLimit(device, row, current)
        else if (row.revision > current.sentRevision && current.token && (current.sentAt === null || at - current.sentAt >= PUSH_INTERVAL_MS)) {
          await updateOn(device, row, current, true)
        }
      } catch (err) {
        deps.projectLog(row.project, 'warn', `Live Activity ${JSON.stringify(row.key)} on ${device.name}: ${(err as Error).message}`)
      }
    }
  }

  async function pastLimit(device: Device, row: ActivityRow, current: DeviceRow): Promise<void> {
    const canRestart = registry.connected(device.id) || Boolean(relay && device.push && device.liveActivityStartToken)
    // The new activity starts before the old one ends, so a failed start
    // leaves the old one to show "Still running". The app ends an activity
    // with the same ID itself when it starts one.
    if (row.pastLimit === 'restart' && canRestart) {
      let delivery: 'app' | 'push' | undefined
      try {
        delivery = await startOn(device, row)
      } catch (err) {
        deps.projectLog(row.project, 'warn', `Restarting Live Activity ${JSON.stringify(row.key)} on ${device.name} before iOS's 8 hour limit failed: ${(err as Error).message}. It shows "Still running" instead`)
      }
      if (delivery) {
        if (delivery === 'push' && current.token) {
          const state = deviceState(row.content, false)
          await push(device, row, { event: 'end', token: current.token, state, priority: 10, dismissalDate: Math.floor(now() / 1000), ttlS: 12 * 60 * 60 }).catch(
            (err: unknown) => deps.projectLog(row.project, 'warn', `Ending the old Live Activity ${JSON.stringify(row.key)} on ${device.name} failed: ${(err as Error).message}`),
          )
        }
        return
      }
    }
    db.prepare('UPDATE live_activity_devices SET still_running = 1 WHERE activity_id = ? AND device_id = ?').run(row.id, device.id)
    await updateOn(device, row, { ...current, stillRunning: true }, true)
  }

  function forDevice(deviceName: string): Scope {
    return { device: requireAllowed(deps.findReachable(deviceName)).id }
  }

  return {
    async startOnDevice(project: string, deviceName: string, args: unknown) {
      const device = requireAllowed(deps.findReachable(deviceName))
      return startFor(project, parseStart(args), [device])
    },
    async startForPerson(project: string, person: number, args: unknown) {
      const parsed = parseStart(args, { person: true })
      return startFor(project, parsed, personTargets(person, parsed.devices))
    },
    update: (project: string, key: unknown, changes: unknown, scope: Scope) => update(project, key, changes, scope),
    end: (project: string, key: unknown, options: unknown, scope: Scope) => end(project, key, options, scope),
    forDevice,
    forPerson(person: number): Scope {
      if (!deps.personDevices(person)) throw new DeviceError('unknown_person', `No person with ID ${JSON.stringify(person)}. ctx.people() lists them`)
      return { person }
    },
    startHere,
    stateEvent,
    startTokenEvent,
    actionEvent,
    tick,
  }
}
