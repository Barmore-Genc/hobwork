import { randomUUID } from 'node:crypto'
import type {
  AlarmEvent,
  DeviceEvent,
  DeviceInfo,
  HealthSample,
  HealthType,
  NfcRecord,
  NfcScannedEvent,
  NotificationActionEvent,
} from '../../../packages/sdk/src/devices.ts'
import type { Caller, Person } from '../../../packages/sdk/src/people.ts'
import { isAllowed } from '../auth/users.ts'
import type { Allowlist } from '../config.ts'
import type { Host } from '../host.ts'
import { getPerson, listPeople } from '../people.ts'
import { getProject, listProjects } from '../projects.ts'
import { appendLog } from '../runtime/logs.ts'
import { createUploads, type Completed } from '../runtime/uploads.ts'
import { createHobSurfaces, WIDGETS_CAPABILITY, type Declarations, type RouteAnswer } from './hob-surfaces.ts'
import { createLiveActivities, type Scope } from './live-activities.ts'
import { createNotifications, nextDelivery } from './notifications.ts'
import { MAX_PAYLOAD_BYTES, PayloadTooLarge, pushSize, type PushInfo, type PushMessage, type PushSender } from './push/relay.ts'
import { commandSpec, fallbackBody, HEALTH_TYPES, knownMethods, promptAlert } from './commands.ts'
import {
  CLOSE_OWNER_NOT_ALLOWED,
  CLOSE_REVOKED,
  createDeviceRegistry,
  DeviceError,
  type DeviceConnection,
  type DeviceRegistry,
  type HostMessage,
} from './registry.ts'
import {
  NFC_TAG_ID,
  answerCommand,
  COMMAND_TTL_MS,
  deleteNfcTag,
  expireCommands,
  findDeviceByName,
  getCommand,
  getDevice,
  listDevices,
  newNfcTagId,
  nfcTagProject,
  pendingCommands,
  recordCommand,
  recordNfcTag,
  revokeDevice,
  setPush,
  type CommandRecord,
  type Device,
} from './store.ts'

// A `device` block of a trigger in hobwork.json. device limits it to one
// device by name, url (nfc/scanned only) to scanned URLs starting with it.
export type DeviceTrigger = { capability: string; event: string; device?: string; url?: string }

// Capability/event pairs the app sends and hobwork.json triggers may name.
export const DEVICE_EVENTS = [
  'notifications/action',
  'focus/changed',
  'nfc/scanned',
  'health/samples',
  'alarms/fired',
  'alarms/stopped',
  'alarms/repeated',
] as const

const ALARM_EVENTS = ['fired', 'stopped', 'repeated']
// Commands another device of the same person may hand over through the host:
// the bridge's "write on my iPhone" from an iPad or Mac without NFC.
const HANDOFF_METHODS = new Set(['nfc.write', 'nfc.read'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UID = /^[0-9a-f]{2,64}$/

export type AppEvent = { capability: unknown; name: unknown; data?: unknown }

export type DeviceSummary = DeviceInfo & {
  id: number
  appVersion: string | null
  push: boolean
  createdAt: string
  // False once the owner was taken off HOBWORK_ALLOWED_USERS. Projects no
  // longer see or reach the device.
  ownerAllowed: boolean
}

export const BACKGROUND_WAIT_MS = 30_000
export const FOREGROUND_WAIT_MS = 120_000
// A background command sent over a socket that stays silent this long also
// goes by push: the socket may be half-open after the phone changed networks,
// and the app runs a command it gets twice only once.
export const SOCKET_FALLBACK_MS = 10_000
const EXPIRY_INTERVAL_MS = 60_000
const MAX_HEALTH_EVENT_SAMPLES = 500
const MAX_FOCUS_LABEL = 64
// Tags hold at most a few KB; this also bounds what goes into a handler's payload.
const MAX_SCANNED_URL_BYTES = 8192
const MAX_SCANNED_RECORDS = 16
const MAX_SCANNED_RECORD_BYTES = 8192
const NFC_RECORD_TYPES = ['url', 'text', 'other']
const MAX_LOGGED_RESULT = 500
// Notifications waiting for deliverAt are checked at least this often, so a
// clock that jumps cannot delay them by much.
const MAX_SCHEDULE_WAIT_MS = 60_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bad(message: string): never {
  throw new DeviceError('bad_request', message)
}

function commandPush(project: string, command: CommandRecord, foreground: boolean, from?: string): PushMessage {
  return {
    id: command.id,
    kind: foreground ? 'prompt' : 'command',
    payload: commandPushPayload(project, command, foreground, from),
    expiresAt: Math.floor(Date.parse(command.expiresAt) / 1000),
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

type Waiter = {
  command: CommandRecord
  device: string
  foreground: boolean
  message: PushMessage
  resolve: (value: unknown) => void
  reject: (err: DeviceError) => void
  timer: NodeJS.Timeout
  // The connection the command went to, while it is open.
  connection?: DeviceConnection
  fallback?: NodeJS.Timeout
  pushed: boolean
}

// The command object in pushes and what the NSE and the app run.
function pushCommand(command: CommandRecord, foreground: boolean) {
  return {
    id: command.id,
    capability: command.capability,
    method: command.method,
    args: command.args,
    expiresAt: command.expiresAt,
    ...(foreground ? { foreground: true } : {}),
  }
}

// Background commands go as a passive alert that the notification service
// extension turns into the command and whose text it replaces with what
// happened. Background pushes (content-available) are throttled and dropped
// after a force quit, so they are not used. Foreground commands are an
// ordinary alert the person taps to open the app.
export function commandPushPayload(project: string, command: CommandRecord, foreground: boolean, from?: string) {
  const hobwork = { project, command: pushCommand(command, foreground) }
  if (foreground) {
    const alert = promptAlert(project, command.capability, command.method, command.args as Record<string, unknown>, from)
    return { aps: { alert, sound: 'default', 'thread-id': project }, hobwork }
  }
  return {
    aps: {
      alert: { title: project, body: fallbackBody(command.capability, command.method) },
      'mutable-content': 1,
      'interruption-level': 'passive',
      'thread-id': project,
    },
    hobwork,
  }
}

function parseOutcome(message: { ok?: unknown; value?: unknown; error?: unknown }): Outcome {
  if (message.ok === true) return { ok: true, value: message.value ?? null }
  const error = isObject(message.error) ? message.error : {}
  return {
    ok: false,
    error: {
      code: typeof error.code === 'string' && error.code ? error.code.slice(0, 64) : 'device_error',
      message: typeof error.message === 'string' && error.message ? error.message.slice(0, 2000) : 'The device reported an error',
    },
  }
}

// Trigger url prefixes that are URLs compare in their normalized form, so
// "https://Example.com" matches "https://example.com/a" but not
// "https://example.com.evil.example/".
function urlPrefix(prefix: string): string {
  return URL.canParse(prefix) ? new URL(prefix).href : prefix
}

function scannedUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined
  const url = new URL(value).href
  return Buffer.byteLength(url) <= MAX_SCANNED_URL_BYTES ? url : undefined
}

// undefined without records, null for invalid ones.
function scannedRecords(value: unknown): NfcRecord[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_SCANNED_RECORDS) return null
  const valid = value.every(
    (r) =>
      isObject(r) &&
      NFC_RECORD_TYPES.includes(r.type as string) &&
      typeof r.value === 'string' &&
      Buffer.byteLength(r.value) <= MAX_SCANNED_RECORD_BYTES,
  )
  return valid ? (value as Record<string, unknown>[]).map((r) => ({ type: r.type, value: r.value }) as NfcRecord) : null
}

// What the app adds to a write's result: the tag's hardware ID (hex) and
// whether reading it back matched.
function written(value: unknown): { uid?: string; verified?: boolean } {
  if (!isObject(value)) return {}
  return {
    ...(typeof value.uid === 'string' && UID.test(value.uid) ? { uid: value.uid } : {}),
    ...(typeof value.verified === 'boolean' ? { verified: value.verified } : {}),
  }
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length > MAX_LOGGED_RESULT ? `${text.slice(0, MAX_LOGGED_RESULT)}...` : text
}

const EVERYONE: Allowlist = { emails: [], subjects: [], everyone: true }

export type Devices = ReturnType<typeof createDevices>

export function createDevices(options: {
  host: Host
  relay?: PushSender
  // Devices of people no longer on it are hidden from projects.
  allowlist?: Allowlist
  registry?: DeviceRegistry
  // Origin of NFC tag URLs.
  publicUrl?: string
  // The deployed version's device triggers of a project, from hobwork.json.
  triggers?: (project: string) => Promise<Record<string, { device?: DeviceTrigger }>>
  invokeTrigger?: (project: string, name: string, payload: DeviceEvent) => Promise<unknown>
  // Runs a route of the deployed version for a notification action. Resolves
  // with the status the handler answered.
  invokeRoute?: (project: string, request: { method: string; path: string; body?: unknown }, caller: Caller) => Promise<number>
  // Runs a route of the deployed version for a widget or an intent, with its answer.
  callRoute?: (project: string, request: { method: string; path: string; body?: unknown }, caller: Caller) => Promise<RouteAnswer>
  // The widget, intents, share targets, uploads and link rules the deployed
  // version declares in hobwork.json.
  declarations?: (project: string) => Promise<Declarations>
  // Runs the triggers of an upload a shared file arrived through.
  uploaded?: (project: string, done: Completed, caller: Caller) => Promise<void>
  // Tests shorten how long calls wait and move the clock.
  waitMs?: { background: number; foreground: number }
  socketFallbackMs?: number
  withdrawWaitMs?: number
  now?: () => number
}) {
  const { host, relay } = options
  const registry = options.registry ?? createDeviceRegistry()
  const publicUrl = options.publicUrl ?? 'http://localhost'
  const now = options.now ?? Date.now
  const waitMs = options.waitMs ?? { background: BACKGROUND_WAIT_MS, foreground: FOREGROUND_WAIT_MS }
  const socketFallbackMs = options.socketFallbackMs ?? SOCKET_FALLBACK_MS
  const closers: (() => void)[] = []
  const waiters = new Map<string, Waiter>()
  const expiry = setInterval(() => {
    try {
      expire()
    } catch (err) {
      console.error('Expiring device commands failed', err)
    }
    liveActivities.tick().catch((err: unknown) => console.error('Checking Live Activities failed', err))
  }, EXPIRY_INTERVAL_MS)
  expiry.unref()
  // Wakes up for the next notification waiting for deliverAt, if any.
  let schedule: NodeJS.Timeout | undefined
  let closed = false
  function scheduleNext() {
    clearTimeout(schedule)
    if (closed) return
    const next = nextDelivery(host.db)
    if (next === undefined) return
    schedule = setTimeout(
      () => {
        notifications
          .deliverDue()
          .catch((err: unknown) => console.error('Sending scheduled notifications failed', err))
          .then(scheduleNext)
          .catch((err: unknown) => console.error('Scheduling notifications failed', err))
      },
      Math.min(Math.max(next - now(), 0), MAX_SCHEDULE_WAIT_MS),
    )
    schedule.unref()
  }

  function ownerAllowed(device: Device): boolean {
    if (!options.allowlist) return true
    return isAllowed(host.db, options.allowlist, { id: device.userId, name: device.owner, email: device.ownerEmail })
  }

  // A device whose owner may no longer sign in also loses its socket once noticed.
  function reachable(device: Device | undefined): device is Device {
    if (!device) return false
    if (ownerAllowed(device)) return true
    registry.disconnect(device.id, CLOSE_OWNER_NOT_ALLOWED, 'The owner of this device can no longer sign in')
    return false
  }

  function summary(device: Device): DeviceSummary {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      owner: device.owner,
      ownerId: device.userId,
      capabilities: device.capabilities,
      connected: registry.connected(device.id),
      lastSeenAt: device.lastSeenAt,
      lastActiveAt: device.lastActiveAt,
      appVersion: device.appVersion,
      push: Boolean(relay) && device.push !== null,
      createdAt: device.createdAt,
      ownerAllowed: ownerAllowed(device),
    }
  }

  function info(): DeviceInfo[] {
    return listDevices(host.db)
      .filter(reachable)
      .map((d) => {
        const { name, platform, owner, ownerId, capabilities, connected, lastSeenAt, lastActiveAt } = summary(d)
        return { name, platform, owner, ownerId, capabilities, connected, lastSeenAt, lastActiveAt }
      })
  }

  function projectLog(project: string, level: 'info' | 'warn', message: string) {
    try {
      appendLog(host, { project, source: 'runtime', level, event: 'trigger', message })
    } catch (err) {
      console.error(`Could not record a device event for ${project}`, err)
    }
  }

  // With the invocation that made the command, when it still exists.
  function commandLog(command: CommandRecord, level: 'info' | 'warn', message: string) {
    const entry = { project: command.project, source: 'runtime' as const, level, message }
    try {
      appendLog(host, command.invocation === null ? entry : { ...entry, invocationId: command.invocation })
    } catch {
      try {
        appendLog(host, entry)
      } catch (err) {
        console.error(`Could not record a device command result for ${command.project}`, err)
      }
    }
  }

  function findReachable(deviceName: string): Device {
    const device = typeof deviceName === 'string' ? findDeviceByName(host.db, deviceName) : undefined
    if (reachable(device)) return device
    const names = listDevices(host.db)
      .filter(ownerAllowed)
      .map((d) => d.name)
    throw new DeviceError(
      'unknown_device',
      `No device called ${JSON.stringify(deviceName)}. ${names.length ? `Paired devices: ${names.join(', ')}` : 'No device is paired with Hobwork yet'}`,
    )
  }

  function personDevices(id: number): Device[] | undefined {
    if (!getPerson(host.db, options.allowlist ?? EVERYONE, id)) return undefined
    return listDevices(host.db)
      .filter((d) => d.userId === id && reachable(d))
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '') || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))
  }

  const notifications = createNotifications({
    host,
    registry,
    ...(relay ? { relay } : {}),
    now,
    findReachable,
    personDevices,
    reachable,
    projectLog,
    ...(options.invokeRoute ? { invokeRoute: options.invokeRoute } : {}),
    ...(options.withdrawWaitMs !== undefined ? { withdrawWaitMs: options.withdrawWaitMs } : {}),
    onScheduled: () => scheduleNext(),
  })
  scheduleNext()

  const liveActivities = createLiveActivities({
    host,
    registry,
    ...(relay ? { relay } : {}),
    now,
    findReachable,
    personDevices,
    reachable,
    projectLog,
    ...(options.invokeRoute ? { invokeRoute: options.invokeRoute } : {}),
  })

  const surfaces = createHobSurfaces({
    host,
    registry,
    ...(relay ? { relay } : {}),
    now,
    ...(options.declarations ? { declarations: options.declarations } : {}),
    ...(options.callRoute ? { callRoute: options.callRoute } : {}),
    ...(options.uploaded ? { uploaded: options.uploaded } : {}),
    uploads: createUploads(host),
    projectLog,
  })

  function reloadWidgets(target: { device?: string; person?: number }) {
    if (target.device !== undefined) {
      const device = findReachable(target.device)
      if (!device.capabilities.includes(WIDGETS_CAPABILITY)) {
        throw new DeviceError('unsupported', `${device.name} shows no widgets. Widgets need the Hobwork app on an iPhone or iPad`)
      }
      return surfaces.reload([device])
    }
    const owned = personDevices(target.person!)
    if (!owned) throw new DeviceError('unknown_person', `No person with ID ${JSON.stringify(target.person)}. ctx.people() lists them`)
    if (!owned.some((d) => d.capabilities.includes(WIDGETS_CAPABILITY))) {
      throw new DeviceError('unreachable', `Person ${target.person} has no device that shows widgets`)
    }
    return surfaces.reload(owned)
  }

  // Which devices ctx.liveActivities, ctx.device(name).liveActivities and
  // ctx.person(id).liveActivities change.
  function liveActivityScope(target: { device?: string; person?: number }): Scope {
    if (target.device !== undefined) return liveActivities.forDevice(target.device)
    if (target.person !== undefined) return liveActivities.forPerson(target.person)
    return 'all'
  }

  const CAPABILITY_NAMES: Record<string, string> = {
    alarms: 'alarms',
    focus: 'Focus status',
    nfc: 'NFC',
    health: 'Health data',
    homekit: 'HomeKit',
  }

  // A call other than notifications.send. Resolves with the device's answer,
  // or throws its error, "timeout" when it does not answer in time (the
  // command may still run until it expires), or a delivery failure.
  async function callCommand(
    project: string,
    deviceName: string,
    capability: string,
    method: string,
    args?: unknown,
    invocation?: number,
    // The person's device that handed this command over, for the prompt's text.
    from?: string,
  ): Promise<unknown> {
    const spec = commandSpec(capability, method)
    if (!spec) throw new DeviceError('unsupported', `Hobwork does not know ${capability}.${method}. Devices can do ${knownMethods()}`)
    const device = findReachable(deviceName)
    if (!device.capabilities.includes(capability)) {
      throw new DeviceError(
        'unsupported',
        `${device.name} has not said it can use ${CAPABILITY_NAMES[capability] ?? capability}. Set it up in the Hobwork app's settings on the device and allow it`,
      )
    }
    if (args !== undefined && args !== null && !isObject(args)) bad(`${capability}.${method} takes an object`)
    const parsed = spec.parse((args ?? {}) as Record<string, unknown>, now())
    const projectRow = getProject(host, project)
    if (!projectRow) bad(`Hob "${project}" does not exist`)
    const tag = capability === 'nfc' && method === 'write' && parsed.url === undefined ? newNfcTagId() : undefined
    let sent = tag ? { tag, url: `${publicUrl}/nfc/${tag}`, ...parsed } : parsed
    // Alarms use it for event routing; HomeKit uses it to name the requesting hob in its approval prompt.
    if (capability === 'homekit' || capability === 'alarms' && ['set', 'timer', 'reschedule'].includes(method)) sent = { ...sent, hob: project }
    const id = randomUUID()
    const createdAt = now()
    const draft: CommandRecord = {
      id,
      deviceId: device.id,
      project,
      invocation: invocation ?? null,
      capability,
      method,
      args: sent,
      status: 'pending',
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + COMMAND_TTL_MS).toISOString(),
    }
    const foreground = Boolean(spec.foreground)
    const message = commandPush(project, draft, foreground, from)
    // Checked before anything is sent, so every command can also go by push.
    const size = pushSize(message, now())
    if (size > MAX_PAYLOAD_BYTES) {
      throw new DeviceError('too_large', `The command is ${size} bytes as a push, and Apple allows ${MAX_PAYLOAD_BYTES}. Send less`)
    }
    expire()
    if (tag) recordNfcTag(host.db, tag, projectRow.id, createdAt)
    const command = recordCommand(host.db, { id, deviceId: device.id, projectId: projectRow.id, invocation, capability, method, args: sent }, createdAt)

    const wait = foreground ? waitMs.foreground : waitMs.background
    const answered = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = waiters.get(id)
        if (!waiter) return
        forget(waiter)
        reject(
          new DeviceError(
            'timeout',
            `${device.name} did not answer ${capability}.${method} within ${Math.round(wait / 1000)}s. The command was sent and may still run until ${command.expiresAt}; its result will be in the project log`,
          ),
        )
      }, wait)
      waiters.set(id, { command, device: device.name, foreground, message, resolve, reject, timer, pushed: false })
    })
    // Keeps a failed delivery from being an unhandled rejection before it is awaited.
    answered.catch(() => {})
    const waiter = waiters.get(id)!
    if (!sendOverSocket(waiter)) {
      try {
        await push(waiter, `${device.name} is not connected`)
      } catch (err) {
        // A command that reached nothing must not run later by surprise.
        const error = err as DeviceError
        answerCommand(host.db, id, { ok: false, error: { code: error.code, message: error.message } }, now())
        if (tag) deleteNfcTag(host.db, tag)
        forget(waiter)
        throw err
      }
    }
    return answered
  }

  function forget(waiter: Waiter) {
    clearTimeout(waiter.timer)
    clearTimeout(waiter.fallback)
    waiters.delete(waiter.command.id)
  }

  function callMessage(command: CommandRecord) {
    return {
      type: 'call' as const,
      id: command.id,
      capability: command.capability,
      method: command.method,
      args: command.args,
      expiresAt: command.expiresAt,
    }
  }

  function sendOverSocket(waiter: Waiter): boolean {
    let connection: DeviceConnection | undefined
    try {
      connection = registry.send(waiter.command.deviceId, callMessage(waiter.command))
    } catch {
      return false
    }
    if (!connection) return false
    waiter.connection = connection
    if (!waiter.foreground && !waiter.pushed) {
      clearTimeout(waiter.fallback)
      waiter.fallback = setTimeout(() => fallBackToPush(waiter, `${waiter.device} did not answer on its connection`), socketFallbackMs)
    }
    return true
  }

  // For a command the socket took but did not answer. The handler keeps
  // waiting either way, so a failed push is only logged.
  function fallBackToPush(waiter: Waiter, reason: string) {
    if (waiter.pushed || waiters.get(waiter.command.id) !== waiter) return
    push(waiter, reason).catch((err: unknown) =>
      commandLog(waiter.command, 'warn', `Device ${waiter.device}: ${waiter.command.capability}.${waiter.command.method}: ${(err as Error).message}`),
    )
  }

  async function push(waiter: Waiter, offline: string): Promise<void> {
    const { command } = waiter
    if (!relay) throw new DeviceError('unreachable', `${offline}, and this Hobwork host does not send push notifications`)
    const device = getDevice(host.db, command.deviceId)
    if (!device?.push) throw new DeviceError('unreachable', `${offline}, and it has not registered for push notifications`)
    waiter.pushed = true
    let result
    try {
      result = await relay.send(device.push, waiter.message)
    } catch (err) {
      waiter.pushed = false
      if (err instanceof PayloadTooLarge) throw new DeviceError('too_large', err.message)
      throw new DeviceError('push_failed', `${offline}, and the push relay could not be reached: ${(err as Error).message}`)
    }
    if (!result.ok) {
      waiter.pushed = false
      if (result.gone) setPush(host.db, device.id, null)
      throw new DeviceError('push_failed', `${offline}, and the push relay refused the push: ${result.reason}`)
    }
  }

  // A connection a command went to closed before it answered. A newer
  // connection of the device gets the command after its hello instead.
  registry.onDetach((connection) => {
    for (const waiter of waiters.values()) {
      if (waiter.connection !== connection) continue
      waiter.connection = undefined
      clearTimeout(waiter.fallback)
      if (registry.connected(waiter.command.deviceId)) continue
      fallBackToPush(waiter, `${waiter.device} disconnected before it answered`)
    }
  })

  // Every hello: commands still pending go to the app again, oldest first.
  // The app runs each command once, however often it arrives.
  function resendPending(deviceId: number) {
    notifications
      .resendWithdrawals(deviceId)
      .catch((err: unknown) => console.error(`Withdrawing notifications from device ${deviceId} failed`, err))
    expire()
    for (const command of pendingCommands(host.db, deviceId, now())) {
      const waiter = waiters.get(command.id)
      if (waiter) {
        clearTimeout(waiter.fallback)
        if (!sendOverSocket(waiter)) return
        continue
      }
      try {
        if (!registry.send(deviceId, callMessage(command))) return
      } catch {
        return
      }
    }
  }

  // Results over the socket or POST /api/devices/results. The first result of
  // a command wins; "unknown" for an ID that is not this device's command.
  function handleResult(deviceId: number, message: { id?: unknown; ok?: unknown; value?: unknown; error?: unknown }): 'unknown' | 'ignored' | 'accepted' {
    if (typeof message.id !== 'string') return 'unknown'
    const command = getCommand(host.db, message.id)
    if (!command || command.deviceId !== deviceId) return 'unknown'
    let outcome = parseOutcome(message)
    if (!answerCommand(host.db, command.id, outcome, now())) return 'ignored'
    if (command.capability === 'nfc' && command.method === 'write') {
      const { tag, url } = command.args as { tag?: string; url: string }
      if (outcome.ok) outcome = { ok: true, value: { ...(tag ? { tag } : {}), url, ...written(outcome.value) } }
      else if (tag) deleteNfcTag(host.db, tag)
    }
    const waiter = waiters.get(command.id)
    const what = `${command.capability}.${command.method}`
    if (waiter) {
      forget(waiter)
      if (outcome.ok) waiter.resolve(outcome.value)
      else waiter.reject(new DeviceError(outcome.error.code, outcome.error.message))
      return 'accepted'
    }
    const name = getDevice(host.db, deviceId)?.name ?? `device ${deviceId}`
    if (outcome.ok) commandLog(command, 'info', `Device ${name}: ${what} finished after the handler stopped waiting: ${short(outcome.value)}`)
    else {
      commandLog(
        command,
        'warn',
        `Device ${name}: ${what} failed after the handler stopped waiting: ${outcome.error.code}: ${outcome.error.message}`,
      )
    }
    return 'accepted'
  }

  function expire() {
    for (const command of expireCommands(host.db, now())) {
      const tag = command.capability === 'nfc' && command.method === 'write' ? (command.args as { tag?: string }).tag : undefined
      if (tag) deleteNfcTag(host.db, tag)
      const name = getDevice(host.db, command.deviceId)?.name ?? `device ${command.deviceId}`
      commandLog(command, 'warn', `Device ${name}: ${command.capability}.${command.method} expired without an answer from the device`)
    }
  }

  // scan is set for nfc/scanned. Triggers with a url only match links that
  // start with it, and links that are not Hobwork tags (foreign) only match
  // triggers with a url, so projects do not get scans they never asked for.
  function matching(
    entries: Record<string, { device?: DeviceTrigger }>,
    capability: string,
    event: string,
    device: string | null,
    scan?: { url: string; foreign: boolean },
  ): string[] {
    return Object.entries(entries)
      .filter(([, entry]) => {
        const trigger = entry.device
        if (trigger?.capability !== capability || trigger.event !== event) return false
        if (trigger.device !== undefined && trigger.device !== device) return false
        if (!scan) return true
        if (typeof trigger.url !== 'string') return !scan.foreign
        return scan.url.startsWith(urlPrefix(trigger.url))
      })
      .map(([name]) => name)
  }

  function run(project: string, names: string[], payload: DeviceEvent) {
    for (const name of names) {
      Promise.resolve()
        .then(() => options.invokeTrigger?.(project, name, payload))
        .catch((err: unknown) =>
          projectLog(project, 'warn', `Running trigger "${name}" for ${payload.capability}/${payload.event} failed: ${(err as Error).message}`),
        )
    }
  }

  // Events the app sends over its socket or POST /api/devices/events.
  // Unknown ones are ignored, so older hosts work with newer apps. Resolves
  // once the triggers started, not when they finish: a handler may run for
  // minutes, and iOS gives an app woken in the background a few seconds.
  async function handleEvent(deviceId: number, event: AppEvent): Promise<void> {
    if (!isObject(event.data)) return
    const device = getDevice(host.db, deviceId)
    if (!reachable(device)) return
    const data = event.data
    const pair = `${String(event.capability)}/${String(event.name)}`
    if (pair === 'notifications/action') return notificationAction(device, data)
    if (pair === 'nfc/scanned') return nfcEvent(device.name, data)
    if (pair === 'liveActivities/state') return liveActivities.stateEvent(device, data)
    if (pair === 'liveActivities/startToken') return liveActivities.startTokenEvent(device, data)
    if (pair === 'liveActivities/action') return liveActivities.actionEvent(device, data)
    if (event.capability === 'alarms' && ALARM_EVENTS.includes(event.name as string)) return alarmEvent(device.name, event.name as string, data)
    if (pair === 'focus/changed') {
      const { label, active } = data
      if (typeof label !== 'string' || !label || label.length > MAX_FOCUS_LABEL || typeof active !== 'boolean') return
      return broadcast({ device: device.name, capability: 'focus', event: 'changed', label, active })
    }
    if (pair === 'health/samples') {
      const { type, samples } = data
      if (!(HEALTH_TYPES as readonly unknown[]).includes(type)) return
      if (!Array.isArray(samples) || !samples.length || samples.length > MAX_HEALTH_EVENT_SAMPLES || !samples.every(isObject)) return
      return broadcast({
        device: device.name,
        capability: 'health',
        event: 'samples',
        type: type as HealthType,
        samples: samples as HealthSample[],
      })
    }
  }

  // Focus and Health events and scans of tags Hobwork did not write belong to
  // no project, so they go to every project whose deployed version has a
  // matching trigger.
  async function broadcast(payload: DeviceEvent) {
    const scan = payload.capability === 'nfc' ? { url: payload.url, foreign: true } : undefined
    for (const { name: project } of listProjects(host)) {
      let entries: Record<string, { device?: DeviceTrigger }>
      try {
        entries = (await options.triggers?.(project)) ?? {}
      } catch {
        // Projects that were never deployed have no triggers.
        continue
      }
      run(project, matching(entries, payload.capability, payload.event, payload.device, scan), payload)
    }
  }

  // alarms/fired, stopped and repeated, from the app. The app names the hob
  // that set the alarm: the host added it to the command, or the bridge knows
  // the page's hob. Events of hobs without a matching trigger are dropped.
  async function alarmEvent(device: string, name: string, data: Record<string, unknown>) {
    const { id, hob, title, seconds } = data
    if (typeof id !== 'string' || !UUID.test(id) || typeof hob !== 'string' || !getProject(host, hob)) return
    let entries: Record<string, { device?: DeviceTrigger }>
    try {
      entries = (await options.triggers?.(hob)) ?? {}
    } catch {
      return
    }
    const payload: AlarmEvent = {
      device,
      capability: 'alarms',
      event: name as AlarmEvent['event'],
      id: id.toLowerCase(),
      ...(typeof title === 'string' && title.length <= 100 ? { title } : {}),
      ...(typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0 ? { seconds } : {}),
    }
    run(hob, matching(entries, 'alarms', name, device), payload)
  }

  // The hob that wrote a Hobwork tag, for the app to hand a scan to an open page of it.
  function nfcTagHob(url: string): { tag: string; url: string; hob: string } | undefined {
    const normalized = scannedUrl(url)
    const tag = normalized === undefined ? undefined : tagOfUrl(normalized)
    const hob = tag === undefined ? undefined : nfcTagProject(host.db, tag)
    return tag && hob ? { tag, url: `${publicUrl}/nfc/${tag}`, hob } : undefined
  }

  // A command from one of the person's devices that it cannot run itself,
  // such as an NFC write from an iPad, run on another device of theirs:
  // "lastActive" picks the one they used last that can.
  async function handoff(
    fromId: number,
    request: { hob: unknown; device: unknown; capability: unknown; method: unknown; args?: unknown },
  ): Promise<{ device: string; value: unknown }> {
    const from = getDevice(host.db, fromId)
    if (!reachable(from)) throw new DeviceError('unknown_device', 'This device is no longer paired')
    const { hob, device, capability, method } = request
    if (typeof capability !== 'string' || typeof method !== 'string' || !HANDOFF_METHODS.has(`${capability}.${method}`)) {
      bad(`Only ${[...HANDOFF_METHODS].join(' and ')} can run on another device`)
    }
    if (typeof hob !== 'string' || !getProject(host, hob)) bad(`Hob ${JSON.stringify(hob)} does not exist`)
    if (typeof device !== 'string' || !device) bad('device must be a device name or "lastActive"')
    const own = (personDevices(from.userId) ?? []).filter((d) => d.id !== from.id)
    const target =
      device === 'lastActive' ? own.find((d) => d.capabilities.includes(capability)) : own.find((d) => d.name === device)
    if (!target) {
      const names = own.filter((d) => d.capabilities.includes(capability)).map((d) => d.name)
      throw new DeviceError(
        device === 'lastActive' ? 'unreachable' : 'unknown_device',
        `${device === 'lastActive' ? 'None of your other devices' : `You have no other device called ${JSON.stringify(device)} that`} can use ${CAPABILITY_NAMES[capability] ?? capability}.${names.length ? ` Devices that can: ${names.join(', ')}` : ''}`,
      )
    }
    const value = await callCommand(hob, target.name, capability, method, request.args, undefined, from.name)
    return { device: target.name, value }
  }

  // The tag ID of a Hobwork tag URL of this host.
  function tagOfUrl(url: string): string | undefined {
    const prefix = `${publicUrl}/nfc/`
    if (!url.startsWith(prefix)) return undefined
    const tag = url.slice(prefix.length)
    return NFC_TAG_ID.test(tag) ? tag : undefined
  }

  // nfc/scanned from the app: { tag } for a Hobwork tag, { url, records? }
  // for any tag with a URL (the app's scan, or a URL from a Shortcut).
  async function nfcEvent(device: string, data: Record<string, unknown>) {
    const records = scannedRecords(data.records)
    if (records === null) return
    if (typeof data.tag === 'string') {
      await nfcScanned(data.tag, device, records)
      return
    }
    const url = scannedUrl(data.url)
    if (!url) return
    const tag = tagOfUrl(url)
    if (tag) {
      await nfcScanned(tag, device, records)
      return
    }
    await broadcast({ device, capability: 'nfc', event: 'scanned', url, ...(records ? { records } : {}) })
  }

  // A scan of a Hobwork tag, from the app or the tag's web page (device null).
  // Runs the triggers of the project that wrote the tag. False for an unknown tag.
  async function nfcScanned(tag: string, device: string | null, records?: NfcRecord[]): Promise<boolean> {
    const project = nfcTagProject(host.db, tag)
    if (!project) return false
    const url = `${publicUrl}/nfc/${tag}`
    const from = device ?? 'A browser'
    let entries: Record<string, { device?: DeviceTrigger }>
    try {
      entries = (await options.triggers?.(project)) ?? {}
    } catch (err) {
      projectLog(project, 'warn', `${from}: NFC tag ${tag} was scanned, but the hob's triggers could not be read: ${(err as Error).message}`)
      return true
    }
    const names = matching(entries, 'nfc', 'scanned', device, { url, foreign: false })
    if (!names.length) {
      projectLog(
        project,
        'warn',
        `${from}: NFC tag ${tag} was scanned, but no trigger handles it. Add one with "device": { "capability": "nfc", "event": "scanned" } to hobwork.json`,
      )
      return true
    }
    const payload: NfcScannedEvent = { device, capability: 'nfc', event: 'scanned', tag, url, ...(records ? { records } : {}) }
    run(project, names, payload)
    return true
  }

  // A tapped action runs its route, or else the hob's notification action
  // triggers. An action no trigger took stays unanswered, so a retry from the
  // app can still run it.
  async function notificationAction(device: Device, data: Record<string, unknown>): Promise<void> {
    const { id, action } = data
    if (typeof id !== 'string' || typeof action !== 'string') return
    const found = notifications.tapped(device, id, action)
    if (!found) return
    const { row, action: tapped } = found
    if (tapped.route !== undefined) {
      if (notifications.answer(id, device.id)) notifications.runRoute(device, row, tapped)
      return
    }
    if (tapped.open !== undefined) return
    let entries: Record<string, { device?: DeviceTrigger }>
    try {
      entries = (await options.triggers?.(row.project)) ?? {}
    } catch (err) {
      projectLog(
        row.project,
        'warn',
        `${device.name}: action "${action}" was tapped, but the hob's triggers could not be read: ${(err as Error).message}`,
      )
      return
    }
    const names = matching(entries, 'notifications', 'action', device.name)
    if (!names.length) {
      projectLog(
        row.project,
        'warn',
        `${device.name}: action "${action}" was tapped on a notification, but no trigger handles notification actions. Give the action a route, or add a trigger with "device": { "capability": "notifications", "event": "action" } to hobwork.json`,
      )
      return
    }
    if (!notifications.answer(id, device.id)) return
    const payload: NotificationActionEvent = {
      device: device.name,
      capability: 'notifications',
      event: 'action',
      notificationId: row.key,
      action,
      ...(row.content.data !== undefined ? { data: row.content.data } : {}),
    }
    run(row.project, names, payload)
  }

  return {
    registry,
    pushEnabled: Boolean(relay),
    pushInfo: (): PushInfo | null => relay?.info ?? null,
    pushMessage: (): HostMessage => (relay ? { type: 'push', ...relay.info } : { type: 'push', relay: null }),
    ownerAllowed,
    list: (): DeviceSummary[] => listDevices(host.db).map(summary),
    info,
    people: (): Person[] => listPeople(host.db, options.allowlist ?? EVERYONE),
    // Most recently used first. Undefined when there is no such person.
    personDevices(id: number): DeviceInfo[] | undefined {
      const owned = personDevices(id)
      if (!owned) return undefined
      const listed = new Map(info().map((d) => [d.name, d]))
      return owned.map((d) => listed.get(d.name)!).filter(Boolean)
    },
    sendNotification: notifications.sendToDevice,
    notifyPerson: notifications.sendToPerson,
    updateNotification: notifications.update,
    withdrawNotification: notifications.withdraw,
    deliverDue: notifications.deliverDue,
    liveActivities,
    liveActivityScope,
    reloadWidgets,
    surfaces,
    callCommand,
    handleResult,
    resendPending,
    expire,
    handleEvent,
    nfcScanned,
    nfcTagHob,
    handoff,
    revoke(id: number): boolean {
      const revoked = revokeDevice(host.db, id)
      registry.disconnect(id, CLOSE_REVOKED, 'This device was removed from Hobwork')
      return revoked
    },
    // For what the registry does not know about, such as sockets that have
    // not said hello yet.
    onClose(closer: () => void) {
      closers.push(closer)
    },
    close() {
      closed = true
      clearInterval(expiry)
      clearTimeout(schedule)
      for (const waiter of waiters.values()) {
        forget(waiter)
        waiter.reject(new DeviceError('unreachable', 'Hobwork is shutting down'))
      }
      registry.closeAll(1001, 'Hobwork is shutting down')
      for (const closer of closers) closer()
    },
  }
}
