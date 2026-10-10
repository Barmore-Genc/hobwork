import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { DeviceDelivery, InterruptionLevel, SentNotification, SentPersonNotification } from '../../../packages/sdk/src/devices.ts'
import type { Caller } from '../../../packages/sdk/src/people.ts'
import type { Host } from '../host.ts'
import { personOf } from '../people.ts'
import { getProject } from '../projects.ts'
import { MAX_PAYLOAD_BYTES, PayloadTooLarge, pushSize, type PushMessage, type PushSender } from './push/relay.ts'
import { DeviceError, type DeviceRegistry } from './registry.ts'
import { getDevice, setPush, type Device } from './store.ts'

export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_DELIVER_AHEAD_MS = 30 * 24 * 60 * 60 * 1000
const NOTIFICATION_TTL_S = 24 * 60 * 60
// How long a withdrawal waits for an app on its socket before it goes by push.
export const WITHDRAW_WAIT_MS = 4_000
const MAX_ACTIONS = 4
const MAX_TITLE_BYTES = 200
const MAX_BODY_BYTES = 2000
const MAX_DATA_BYTES = 4096
const MAX_PATH = 512
const ACTION_ID = /^[A-Za-z0-9_-]{1,64}$/
const KEY = /^[A-Za-z0-9_.:-]{1,64}$/
const PATH = /^\/[^\s#]*$/
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const LEVELS: InterruptionLevel[] = ['passive', 'active', 'timeSensitive']
// Same length as a real notification ID, for measuring the payload before one exists.
const SAMPLE_ID = '00000000-0000-0000-0000-000000000000'
const SAMPLE_REVISION = 999_999

export type Action = {
  id: string
  title: string
  route?: string
  method?: string
  body?: unknown
  open?: string
  foreground?: boolean
  destructive?: boolean
}

export type Content = {
  title: string
  body?: string
  actions: Action[]
  data?: unknown
  open?: string
  interruptionLevel: InterruptionLevel
  sound: 'default' | 'none'
  thread?: string
}

export type Target = { device: number } | { person: number; devices: 'all' | 'lastActive' }

export type ParsedNotification = Content & { key?: string; deliverAt?: number; devices: 'all' | 'lastActive' }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bad(message: string): never {
  throw new DeviceError('bad_request', message)
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '')
}

function path(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > MAX_PATH || !PATH.test(value)) {
    bad(`${name} must be a path starting with "/", at most ${MAX_PATH} characters`)
  }
  return value
}

function parseActions(actions: unknown): Action[] {
  if (actions === undefined) return []
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) bad(`actions must be a list of at most ${MAX_ACTIONS}`)
  const parsed: Action[] = []
  for (const action of actions) {
    if (!isObject(action) || typeof action.id !== 'string' || !ACTION_ID.test(action.id)) {
      bad('Each action needs an id of letters, digits, "-" and "_" (at most 64)')
    }
    if (typeof action.title !== 'string' || !action.title.trim() || action.title.length > 64) {
      bad('Each action needs a title of at most 64 characters')
    }
    if (parsed.some((a) => a.id === action.id)) bad(`Action id "${action.id}" is used twice`)
    const { route, method, body, open, foreground, destructive } = action
    if (method !== undefined && (typeof method !== 'string' || !METHODS.includes(method))) bad(`An action's method must be one of ${METHODS.join(', ')}`)
    if (method !== undefined && route === undefined) bad('An action with a method needs a route')
    if (body !== undefined && route === undefined) bad('An action with a body needs a route')
    if (body !== undefined && method === 'GET') bad('A GET route takes no body')
    if (body !== undefined && jsonBytes(body) > MAX_DATA_BYTES) bad(`An action's body must be at most ${MAX_DATA_BYTES} bytes as JSON`)
    if (foreground !== undefined && typeof foreground !== 'boolean') bad("An action's foreground must be true or false")
    if (destructive !== undefined && typeof destructive !== 'boolean') bad("An action's destructive must be true or false")
    parsed.push({
      id: action.id,
      title: action.title,
      ...(route !== undefined ? { route: path(route, "An action's route") } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(open !== undefined ? { open: path(open, "An action's open") } : {}),
      ...(foreground ? { foreground } : {}),
      ...(destructive ? { destructive } : {}),
    })
  }
  return parsed
}

function parseText(title: unknown, body: unknown) {
  if (typeof title !== 'string' || !title.trim()) bad('title must be a non-empty string')
  if (Buffer.byteLength(title) > MAX_TITLE_BYTES) bad(`title must be at most ${MAX_TITLE_BYTES} bytes as UTF-8`)
  if (body !== undefined && typeof body !== 'string') bad('body must be a string')
  if (typeof body === 'string' && Buffer.byteLength(body) > MAX_BODY_BYTES) bad(`body must be at most ${MAX_BODY_BYTES} bytes as UTF-8`)
}

function checkData(data: unknown) {
  if (data !== undefined && jsonBytes(data) > MAX_DATA_BYTES) bad(`data must be at most ${MAX_DATA_BYTES} bytes as JSON`)
}

export function parseNotification(args: unknown, now: number, options: { person?: boolean } = {}): ParsedNotification {
  if (!isObject(args)) bad('The notification must be an object with a title')
  const { id, title, body, actions, data, open, interruptionLevel, sound, thread, deliverAt, devices } = args
  parseText(title, body)
  checkData(data)
  if (id !== undefined && (typeof id !== 'string' || !KEY.test(id))) bad('id must be letters, digits and "-_.:", at most 64')
  if (interruptionLevel !== undefined && !LEVELS.includes(interruptionLevel as InterruptionLevel)) {
    bad(`interruptionLevel must be one of ${LEVELS.join(', ')}`)
  }
  if (sound !== undefined && sound !== 'default' && sound !== 'none') bad('sound must be "default" or "none"')
  if (thread !== undefined && (typeof thread !== 'string' || !KEY.test(thread))) bad('thread must be letters, digits and "-_.:", at most 64')
  if (devices !== undefined && (!options.person || (devices !== 'all' && devices !== 'lastActive'))) {
    bad(options.person ? 'devices must be "all" or "lastActive"' : 'devices only works with ctx.person(id).notifications')
  }
  let at: number | undefined
  if (deliverAt !== undefined) {
    at = typeof deliverAt === 'string' ? Date.parse(deliverAt) : NaN
    if (Number.isNaN(at)) bad('deliverAt must be an ISO date-time, e.g. new Date(...).toISOString()')
    if (at > now + MAX_DELIVER_AHEAD_MS) bad('deliverAt must be within the next 30 days')
  }
  const level = (interruptionLevel as InterruptionLevel | undefined) ?? 'active'
  return {
    title: title as string,
    ...(typeof body === 'string' ? { body } : {}),
    actions: parseActions(actions),
    ...(data !== undefined ? { data } : {}),
    ...(open !== undefined ? { open: path(open, 'open') } : {}),
    interruptionLevel: level,
    sound: level === 'passive' ? 'none' : ((sound as 'default' | 'none' | undefined) ?? 'default'),
    ...(thread !== undefined ? { thread: thread as string } : {}),
    ...(id !== undefined ? { key: id as string } : {}),
    ...(at !== undefined && at > now ? { deliverAt: at } : {}),
    devices: (devices as 'all' | 'lastActive' | undefined) ?? 'all',
  }
}

// An update changes what a notification says; how it alerts stays.
export function applyUpdate(content: Content, changes: unknown): Content {
  if (!isObject(changes)) bad('The changes must be an object')
  for (const name of Object.keys(changes)) {
    if (!['title', 'body', 'actions', 'data', 'open'].includes(name)) bad(`An update can change title, body, actions, data and open, not ${name}`)
  }
  const next: Content = { ...content }
  if ('title' in changes) next.title = changes.title as string
  if ('body' in changes) {
    if (changes.body === undefined) delete next.body
    else next.body = changes.body as string
  }
  parseText(next.title, next.body)
  if ('actions' in changes) next.actions = parseActions(changes.actions)
  if ('data' in changes) {
    checkData(changes.data)
    if (changes.data === undefined) delete next.data
    else next.data = changes.data
  }
  if ('open' in changes) {
    if (changes.open === undefined) delete next.open
    else next.open = path(changes.open, 'open')
  }
  return next
}

function threadOf(project: string, content: Content): string {
  return content.thread === undefined ? project : `${project}/${content.thread}`
}

// What the app gets for each action. Routes and bodies stay on the host.
function appActions(actions: Action[]) {
  return actions.map((a) => ({
    id: a.id,
    title: a.title,
    ...(a.foreground || a.open !== undefined ? { foreground: true } : {}),
    ...(a.destructive ? { destructive: true } : {}),
    ...(a.open !== undefined ? { open: a.open } : {}),
  }))
}

// An update replaces the notification quietly, wherever it still shows.
type Mode = 'send' | 'update'

function levelOf(content: Content, mode: Mode): InterruptionLevel {
  return mode === 'update' ? 'passive' : content.interruptionLevel
}

function revisionField(revision: number) {
  return revision > 1 ? { revision } : {}
}

export function appNotification(id: string, project: string, content: Content, revision: number, mode: Mode) {
  const level = levelOf(content, mode)
  return {
    id,
    project,
    title: content.title,
    ...(content.body !== undefined ? { body: content.body } : {}),
    actions: appActions(content.actions),
    ...(level !== 'active' ? { interruptionLevel: level } : {}),
    ...(content.sound === 'none' || mode === 'update' ? { sound: 'none' } : {}),
    ...(content.thread !== undefined ? { thread: threadOf(project, content) } : {}),
    ...(content.open !== undefined ? { open: content.open } : {}),
    ...revisionField(revision),
    ...(mode === 'update' ? { update: true } : {}),
  }
}

const APS_LEVEL: Record<InterruptionLevel, string> = { passive: 'passive', active: 'active', timeSensitive: 'time-sensitive' }

export function pushPayload(id: string, project: string, content: Content, revision: number, mode: Mode) {
  const level = levelOf(content, mode)
  const silent = content.sound === 'none' || mode === 'update'
  return {
    aps: {
      alert: { title: content.title, ...(content.body !== undefined ? { body: content.body } : {}) },
      ...(silent ? {} : { sound: 'default' }),
      ...(level !== 'active' ? { 'interruption-level': APS_LEVEL[level] } : {}),
      'thread-id': threadOf(project, content),
      // Actions differ per notification, so the app's notification service
      // extension registers a category with this ID from hobwork.actions
      // before iOS shows it.
      ...(content.actions.length ? { category: `hobwork.${id}`, 'mutable-content': 1 } : {}),
    },
    // Title and body are in aps.alert only: repeating them here could take a
    // valid notification past APNs' 4 KB.
    hobwork: {
      id,
      project,
      actions: appActions(content.actions),
      ...(content.open !== undefined ? { open: content.open } : {}),
      ...revisionField(revision),
      ...(mode === 'update' ? { update: true } : {}),
    },
  }
}

function alertPush(id: string, project: string, content: Content, revision: number, mode: Mode, now: number): PushMessage {
  return {
    id,
    kind: 'alert',
    payload: pushPayload(id, project, content, revision, mode),
    expiresAt: Math.floor(now / 1000) + NOTIFICATION_TTL_S,
  }
}

// Fields within their limits can be too large together once escaped,
// compressed and encrypted, so the push itself is measured. This runs before
// any delivery, so every notification that is accepted can also go by push.
export function checkPushSize(project: string, content: Content, now: number) {
  const size = pushSize(alertPush(SAMPLE_ID, project, content, SAMPLE_REVISION, 'send', now), now)
  if (size > MAX_PAYLOAD_BYTES) {
    throw new DeviceError(
      'too_large',
      `The notification is ${size} bytes as a push, and Apple allows ${MAX_PAYLOAD_BYTES}. Shorten the title, body or action titles`,
    )
  }
}

// Store

const iso = (ms: number) => new Date(ms).toISOString()

export type NotificationRow = {
  id: string
  projectId: number
  project: string
  key: string
  content: Content
  revision: number
  deliverAt: string | null
  target: Target | null
  withdrawnAt: string | null
}

export type DeliveryRow = {
  deviceId: number
  revision: number
  answeredAt: string | null
  withdrawnAt: string | null
}

function toRow(row: Record<string, unknown>): NotificationRow {
  return {
    id: String(row.id),
    projectId: Number(row.project_id),
    project: String(row.project),
    key: String(row.key),
    content: JSON.parse(String(row.content)) as Content,
    revision: Number(row.revision),
    deliverAt: row.deliver_at === null ? null : String(row.deliver_at),
    target: row.target === null ? null : (JSON.parse(String(row.target)) as Target),
    withdrawnAt: row.withdrawn_at === null ? null : String(row.withdrawn_at),
  }
}

const SELECT_NOTIFICATION = 'SELECT n.*, p.name AS project FROM notifications n JOIN projects p ON p.id = n.project_id'

export function getNotification(db: DatabaseSync, id: string): NotificationRow | undefined {
  const row = db.prepare(`${SELECT_NOTIFICATION} WHERE n.id = ?`).get(id)
  return row ? toRow(row) : undefined
}

export function notificationByKey(db: DatabaseSync, projectId: number, key: string): NotificationRow | undefined {
  const row = db.prepare(`${SELECT_NOTIFICATION} WHERE n.project_id = ? AND n.key = ?`).get(projectId, key)
  return row ? toRow(row) : undefined
}

// A new notification, or the next revision of the one with this key, which
// then shows again even when it was withdrawn.
export function saveNotification(
  db: DatabaseSync,
  record: { projectId: number; key?: string; content: Content; deliverAt?: number; target?: Target },
  now: number,
): NotificationRow {
  db.prepare('DELETE FROM notifications WHERE updated_at <= ? AND deliver_at IS NULL').run(iso(now - NOTIFICATION_RETENTION_MS))
  const id = randomUUID()
  const row = db
    .prepare(
      `INSERT INTO notifications (id, project_id, key, content, deliver_at, target, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT (project_id, key) DO UPDATE SET content = excluded.content, revision = revision + 1,
         deliver_at = excluded.deliver_at, target = excluded.target, updated_at = excluded.updated_at, withdrawn_at = NULL
       RETURNING id`,
    )
    .get(
      id,
      record.projectId,
      record.key ?? id,
      JSON.stringify(record.content),
      record.deliverAt === undefined ? null : iso(record.deliverAt),
      record.target === undefined ? null : JSON.stringify(record.target),
      iso(now),
    )
  return getNotification(db, String(row!.id))!
}

export function updateContent(db: DatabaseSync, id: string, content: Content, now: number): NotificationRow {
  db.prepare('UPDATE notifications SET content = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(content), iso(now), id)
  return getNotification(db, id)!
}

// False when it was already withdrawn.
export function markWithdrawn(db: DatabaseSync, id: string, now: number): boolean {
  const result = db
    .prepare('UPDATE notifications SET withdrawn_at = ?, deliver_at = NULL, target = NULL, updated_at = ? WHERE id = ? AND withdrawn_at IS NULL')
    .run(iso(now), iso(now), id)
  return Number(result.changes) > 0
}

export function deliveries(db: DatabaseSync, id: string): DeliveryRow[] {
  return db
    .prepare('SELECT device_id, revision, answered_at, withdrawn_at FROM notification_deliveries WHERE notification_id = ? ORDER BY device_id')
    .all(id)
    .map((row) => ({
      deviceId: Number(row.device_id),
      revision: Number(row.revision),
      answeredAt: row.answered_at === null ? null : String(row.answered_at),
      withdrawnAt: row.withdrawn_at === null ? null : String(row.withdrawn_at),
    }))
}

export function recordDelivery(db: DatabaseSync, id: string, deviceId: number, revision: number, now: number) {
  db.prepare(
    `INSERT INTO notification_deliveries (notification_id, device_id, revision, delivered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (notification_id, device_id) DO UPDATE SET revision = excluded.revision, delivered_at = excluded.delivered_at,
       answered_at = NULL, withdrawn_at = NULL, removed_at = NULL`,
  ).run(id, deviceId, revision, iso(now))
}

export function forgetDelivery(db: DatabaseSync, id: string, deviceId: number) {
  db.prepare('DELETE FROM notification_deliveries WHERE notification_id = ? AND device_id = ?').run(id, deviceId)
}

// Device IDs that held it and now have to remove it.
export function withdrawDeliveries(db: DatabaseSync, id: string, deviceIds: number[] | 'all', now: number): number[] {
  const rows =
    deviceIds === 'all'
      ? db
          .prepare('UPDATE notification_deliveries SET withdrawn_at = ? WHERE notification_id = ? AND withdrawn_at IS NULL RETURNING device_id')
          .all(iso(now), id)
      : deviceIds.flatMap((deviceId) =>
          db
            .prepare(
              'UPDATE notification_deliveries SET withdrawn_at = ? WHERE notification_id = ? AND device_id = ? AND withdrawn_at IS NULL RETURNING device_id',
            )
            .all(iso(now), id, deviceId),
        )
  return rows.map((row) => Number(row.device_id))
}

// Withdrawn notifications the device has not confirmed it removed.
export function pendingRemovals(db: DatabaseSync, deviceId: number): string[] {
  return db
    .prepare('SELECT notification_id FROM notification_deliveries WHERE device_id = ? AND withdrawn_at IS NOT NULL AND removed_at IS NULL')
    .all(deviceId)
    .map((row) => String(row.notification_id))
}

export function markRemoved(db: DatabaseSync, deviceId: number, ids: string[], now: number) {
  const statement = db.prepare(
    'UPDATE notification_deliveries SET removed_at = ? WHERE device_id = ? AND notification_id = ? AND withdrawn_at IS NOT NULL AND removed_at IS NULL',
  )
  for (const id of ids) statement.run(iso(now), deviceId, id)
}

// Claims notifications whose time came, so each is sent once.
export function claimDue(db: DatabaseSync, now: number): (NotificationRow & { target: Target })[] {
  const due = db
    .prepare(`${SELECT_NOTIFICATION} WHERE n.deliver_at IS NOT NULL AND n.deliver_at <= ? AND n.withdrawn_at IS NULL ORDER BY n.deliver_at`)
    .all(iso(now))
    .map(toRow)
  const claim = db.prepare('UPDATE notifications SET deliver_at = NULL, target = NULL WHERE id = ? AND deliver_at = ?')
  return due
    .filter((row) => Number(claim.run(row.id, row.deliverAt).changes) > 0)
    .map((row) => ({ ...row, deliverAt: null, target: row.target! }))
}

// Unix milliseconds of the earliest notification waiting for deliverAt.
export function nextDelivery(db: DatabaseSync): number | undefined {
  const row = db.prepare('SELECT min(deliver_at) AS at FROM notifications WHERE deliver_at IS NOT NULL AND withdrawn_at IS NULL').get()
  return row?.at == null ? undefined : Date.parse(String(row.at))
}

// The tap on this device's copy of the current revision. False when it was
// handled before: the app may send an action twice (over the socket and by
// HTTP after a reconnect), and the hob must see it once.
export function answerDelivery(db: DatabaseSync, id: string, deviceId: number, now: number): boolean {
  const result = db
    .prepare('UPDATE notification_deliveries SET answered_at = ? WHERE notification_id = ? AND device_id = ? AND answered_at IS NULL')
    .run(iso(now), id, deviceId)
  return Number(result.changes) > 0
}

export function hasDelivery(db: DatabaseSync, id: string, deviceId: number): boolean {
  return db.prepare('SELECT 1 FROM notification_deliveries WHERE notification_id = ? AND device_id = ?').get(id, deviceId) !== undefined
}

// Sending

// Delivery through the app's socket failed in a way that push can fix.
const TRANSPORT_ERRORS = new Set(['not_connected', 'disconnected', 'timeout'])

export type NotificationsDeps = {
  host: Host
  registry: DeviceRegistry
  relay?: PushSender
  now: () => number
  // A paired device projects may use, or a DeviceError.
  findReachable: (name: string) => Device
  // A person's devices projects may use, most recently used first, or
  // undefined for an unknown person.
  personDevices: (id: number) => Device[] | undefined
  reachable: (device: Device | undefined) => device is Device
  projectLog: (project: string, level: 'info' | 'warn', message: string) => void
  // Runs a route of the project's deployed version for an action. Resolves
  // with the HTTP status the handler answered.
  invokeRoute?: (project: string, request: { method: string; path: string; body?: unknown }, caller: Caller) => Promise<number>
  withdrawWaitMs?: number
  // A notification now waits for deliverAt.
  onScheduled?: () => void
}

export type Notifications = ReturnType<typeof createNotifications>

export function createNotifications(deps: NotificationsDeps) {
  const { host, registry, relay, now } = deps
  const withdrawWaitMs = deps.withdrawWaitMs ?? WITHDRAW_WAIT_MS

  function projectId(project: string): number {
    const row = getProject(host, project)
    if (!row) bad(`Hob "${project}" does not exist`)
    return row.id
  }

  function showsNotifications(device: Device): boolean {
    return device.capabilities.includes('notifications')
  }

  function requireNotifications(device: Device): Device {
    if (!showsNotifications(device)) {
      throw new DeviceError('unsupported', `${device.name} has not said it can show notifications. Open the Hobwork app on it and allow notifications`)
    }
    return device
  }

  function personTargets(person: number, which: 'all' | 'lastActive'): Device[] {
    const owned = deps.personDevices(person)
    if (!owned) throw new DeviceError('unknown_person', `No person with ID ${JSON.stringify(person)}. ctx.people() lists them`)
    const usable = owned.filter(showsNotifications)
    if (!usable.length) throw new DeviceError('unreachable', `Person ${person} has no device that shows notifications`)
    return which === 'lastActive' ? usable.slice(0, 1) : usable
  }

  async function pushTo(device: Device, message: PushMessage, offline: string): Promise<void> {
    if (!relay) throw new DeviceError('unreachable', `${offline}, and this Hobwork host does not send push notifications`)
    if (!device.push) throw new DeviceError('unreachable', `${offline}, and it has not registered for push notifications`)
    let result
    try {
      result = await relay.send(device.push, message)
    } catch (err) {
      if (err instanceof PayloadTooLarge) throw new DeviceError('too_large', err.message)
      throw new DeviceError('push_failed', `Could not reach the push relay for ${device.name}: ${(err as Error).message}`)
    }
    if (!result.ok) {
      if (result.gone) setPush(host.db, device.id, null)
      throw new DeviceError('push_failed', `The push relay refused the push for ${device.name}: ${result.reason}`)
    }
  }

  // Over the socket when connected, by push otherwise. The delivery is
  // recorded first, so an action tapped before the app answered still counts.
  async function deliverTo(device: Device, row: NotificationRow, mode: Mode): Promise<'app' | 'push'> {
    const previous = deliveries(host.db, row.id).find((d) => d.deviceId === device.id)
    recordDelivery(host.db, row.id, device.id, row.revision, now())
    try {
      let socketError: DeviceError | undefined
      if (registry.connected(device.id)) {
        try {
          await registry.call(device.id, 'notifications', 'send', appNotification(row.id, row.project, row.content, row.revision, mode))
          return 'app'
        } catch (err) {
          if (!(err instanceof DeviceError) || !TRANSPORT_ERRORS.has(err.code)) throw err
          socketError = err
        }
      }
      const offline = socketError ? `${device.name} did not answer (${socketError.message})` : `${device.name} is not connected`
      await pushTo(device, alertPush(row.id, row.project, row.content, row.revision, mode, now()), offline)
      return 'push'
    } catch (err) {
      if (previous) recordDelivery(host.db, row.id, device.id, previous.revision, now())
      else forgetDelivery(host.db, row.id, device.id)
      throw err
    }
  }

  async function deliverAll(devices: Device[], row: NotificationRow, mode: Mode): Promise<DeviceDelivery[]> {
    return Promise.all(
      devices.map(async (device): Promise<DeviceDelivery> => {
        try {
          return { device: device.name, delivery: await deliverTo(device, row, mode) }
        } catch (err) {
          const error = err instanceof DeviceError ? err : new DeviceError('device_error', (err as Error).message)
          return { device: device.name, error: { code: error.code, message: error.message } }
        }
      }),
    )
  }

  // Removes notifications from a device: over its socket, or with a
  // background push. Until the app confirms, every hello sends them again.
  async function removeFrom(deviceId: number, ids: string[]): Promise<void> {
    if (!ids.length) return
    const device = getDevice(host.db, deviceId)
    if (!deps.reachable(device)) return
    if (registry.connected(deviceId)) {
      try {
        await registry.call(deviceId, 'notifications', 'withdraw', { ids }, withdrawWaitMs)
        markRemoved(host.db, deviceId, ids, now())
        return
      } catch (err) {
        // Apps from before withdrawals cannot remove it, so there is nothing to retry.
        if (err instanceof DeviceError && err.code === 'unsupported') {
          markRemoved(host.db, deviceId, ids, now())
          return
        }
        if (!(err instanceof DeviceError) || !TRANSPORT_ERRORS.has(err.code)) throw err
      }
    }
    if (!relay || !device.push) return
    const message: PushMessage = {
      id: randomUUID(),
      kind: 'background',
      payload: { aps: { 'content-available': 1 }, hobwork: { withdraw: ids } },
      expiresAt: Math.floor(now() / 1000) + NOTIFICATION_TTL_S,
    }
    await pushTo(device, message, `${device.name} is not connected`)
  }

  async function withdrawFrom(row: NotificationRow, deviceIds: number[] | 'all'): Promise<void> {
    const withdrawn = withdrawDeliveries(host.db, row.id, deviceIds, now())
    await Promise.all(
      withdrawn.map((deviceId) =>
        removeFrom(deviceId, [row.id]).catch((err: unknown) =>
          deps.projectLog(
            row.project,
            'warn',
            `Withdrawing notification ${JSON.stringify(row.key)} from device ${getDevice(host.db, deviceId)?.name ?? deviceId} failed: ${(err as Error).message}. The app removes it when it connects again`,
          ),
        ),
      ),
    )
  }

  function heldBy(row: NotificationRow, deviceIds: number[]): number[] {
    return deliveries(host.db, row.id)
      .filter((d) => d.withdrawnAt === null && !deviceIds.includes(d.deviceId))
      .map((d) => d.deviceId)
  }

  // A send with a key in use replaces it: devices outside the new targets
  // lose it, the targets get the new version under the same ID.
  async function store(project: string, parsed: ParsedNotification, target: Target, targets: Device[]) {
    const id = projectId(project)
    checkPushSize(project, parsed, now())
    const { key, deliverAt, devices: _devices, ...content } = parsed
    const row = saveNotification(
      host.db,
      { projectId: id, ...(key !== undefined ? { key } : {}), content, ...(deliverAt !== undefined ? { deliverAt, target } : {}) },
      now(),
    )
    if (deliverAt !== undefined) deps.onScheduled?.()
    await withdrawFrom(row, heldBy(row, deliverAt === undefined ? targets.map((d) => d.id) : []))
    return row
  }

  async function sendToDevice(project: string, deviceName: string, args: unknown): Promise<SentNotification> {
    const device = requireNotifications(deps.findReachable(deviceName))
    const parsed = parseNotification(args, now())
    const row = await store(project, parsed, { device: device.id }, [device])
    if (parsed.deliverAt !== undefined) return { id: row.key, delivery: 'scheduled' }
    return { id: row.key, delivery: await deliverTo(device, row, 'send') }
  }

  async function sendToPerson(project: string, person: number, args: unknown): Promise<SentPersonNotification> {
    const parsed = parseNotification(args, now(), { person: true })
    const targets = personTargets(person, parsed.devices)
    const row = await store(project, parsed, { person, devices: parsed.devices }, targets)
    if (parsed.deliverAt !== undefined) return { id: row.key, scheduled: true, devices: [] }
    return { id: row.key, scheduled: false, devices: await deliverAll(targets, row, 'send') }
  }

  function byKey(project: string, key: unknown): NotificationRow | undefined {
    if (typeof key !== 'string' || !KEY.test(key)) bad('The notification ID must be letters, digits and "-_.:", at most 64')
    return notificationByKey(host.db, projectId(project), key)
  }

  async function update(project: string, key: unknown, changes: unknown): Promise<{ updated: boolean; devices: DeviceDelivery[] }> {
    const current = byKey(project, key)
    if (!current || current.withdrawnAt !== null) return { updated: false, devices: [] }
    const content = applyUpdate(current.content, changes)
    checkPushSize(project, content, now())
    const row = updateContent(host.db, current.id, content, now())
    if (row.deliverAt !== null) return { updated: true, devices: [] }
    const holders = deliveries(host.db, row.id)
      .filter((d) => d.withdrawnAt === null && d.answeredAt === null)
      .map((d) => getDevice(host.db, d.deviceId))
      .filter(deps.reachable)
    return { updated: true, devices: await deliverAll(holders, row, 'update') }
  }

  async function withdraw(project: string, key: unknown): Promise<{ withdrawn: boolean }> {
    const row = byKey(project, key)
    if (!row || !markWithdrawn(host.db, row.id, now())) return { withdrawn: false }
    await withdrawFrom(row, 'all')
    return { withdrawn: true }
  }

  // Notifications whose deliverAt came. Devices are picked now, so a person
  // gets them on the devices they have and use by then.
  async function deliverDue(): Promise<void> {
    for (const due of claimDue(host.db, now())) {
      const where = 'device' in due.target ? `device ${due.target.device}` : `person ${due.target.person}`
      let targets: Device[]
      try {
        if ('device' in due.target) {
          const device = getDevice(host.db, due.target.device)
          if (!deps.reachable(device)) throw new DeviceError('unknown_device', 'The device was removed')
          targets = [requireNotifications(device)]
        } else {
          targets = personTargets(due.target.person, due.target.devices)
        }
      } catch (err) {
        deps.projectLog(due.project, 'warn', `Scheduled notification ${JSON.stringify(due.key)} for ${where} was not sent: ${(err as Error).message}`)
        continue
      }
      const results = await deliverAll(targets, due, 'send')
      for (const result of results) {
        if ('error' in result) {
          deps.projectLog(
            due.project,
            'warn',
            `Scheduled notification ${JSON.stringify(due.key)} did not reach ${result.device}: ${result.error.code}: ${result.error.message}`,
          )
        }
      }
    }
  }

  // After every hello: withdrawals the app missed while it was away.
  async function resendWithdrawals(deviceId: number): Promise<void> {
    const ids = pendingRemovals(host.db, deviceId)
    if (!ids.length || !registry.connected(deviceId)) return
    try {
      await registry.call(deviceId, 'notifications', 'withdraw', { ids }, withdrawWaitMs)
      markRemoved(host.db, deviceId, ids, now())
    } catch (err) {
      if (err instanceof DeviceError && err.code === 'unsupported') markRemoved(host.db, deviceId, ids, now())
    }
  }

  function callerOf(device: Device): Caller {
    return {
      person: personOf(host.db, { id: device.userId, name: device.owner, email: device.ownerEmail }),
      device: { name: device.name, platform: device.platform },
    }
  }

  // A tapped action that names a route. Resolves once the route started:
  // iOS gives an app woken in the background a few seconds.
  function runRoute(device: Device, row: NotificationRow, action: Action): void {
    const request = {
      method: action.method ?? 'POST',
      path: action.route!,
      ...(action.method === 'GET'
        ? {}
        : { body: action.body ?? { notificationId: row.key, action: action.id, ...(row.content.data !== undefined ? { data: row.content.data } : {}) } }),
    }
    const what = `${device.name}: action "${action.id}" on notification ${JSON.stringify(row.key)}: ${request.method} ${request.path}`
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

  // The action on the notification as it was sent to this device, or
  // undefined for one it never had.
  function tapped(device: Device, id: string, actionId: string): { row: NotificationRow; action: Action } | undefined {
    if (!hasDelivery(host.db, id, device.id)) return undefined
    const row = getNotification(host.db, id)
    const action = row?.content.actions.find((a) => a.id === actionId)
    return row && action ? { row, action } : undefined
  }

  return {
    sendToDevice,
    sendToPerson,
    update,
    withdraw,
    deliverDue,
    resendWithdrawals,
    tapped,
    runRoute,
    answer: (id: string, deviceId: number) => answerDelivery(host.db, id, deviceId, now()),
  }
}
