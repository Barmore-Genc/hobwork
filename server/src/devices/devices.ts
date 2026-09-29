import type { DeviceInfo, NotificationActionEvent, SentNotification } from '../../../packages/sdk/src/devices.ts'
import { isAllowed } from '../auth/users.ts'
import type { Allowlist } from '../config.ts'
import type { Host } from '../host.ts'
import { getProject } from '../projects.ts'
import { appendLog } from '../runtime/logs.ts'
import { MAX_PAYLOAD_BYTES, PayloadTooLarge, type Apns } from './apns.ts'
import { CLOSE_OWNER_NOT_ALLOWED, CLOSE_REVOKED, createDeviceRegistry, DeviceError, type DeviceRegistry } from './registry.ts'
import {
  answerNotification,
  findDeviceByName,
  findNotification,
  getDevice,
  listDevices,
  recordNotification,
  revokeDevice,
  setPushToken,
  type Device,
} from './store.ts'

export type DeviceTrigger = { capability: 'notifications'; event: 'action' }

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

// Delivery through the app's socket failed in a way that push can fix.
const TRANSPORT_ERRORS = new Set(['not_connected', 'disconnected', 'timeout'])
const MAX_ACTIONS = 4
const MAX_TITLE_BYTES = 200
const MAX_BODY_BYTES = 2000
const MAX_DATA_BYTES = 4096
const ACTION_ID = /^[A-Za-z0-9_-]{1,64}$/
// Same length as a real notification ID, for measuring the payload before one exists.
const SAMPLE_ID = '00000000-0000-0000-0000-000000000000'

type ParsedNotification = { title: string; body?: string; actions: { id: string; title: string }[]; data?: unknown }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bad(message: string): never {
  throw new DeviceError('bad_request', message)
}

export function parseNotification(args: unknown): ParsedNotification {
  if (!isObject(args)) bad('The notification must be an object with a title')
  const { title, body, actions, data } = args
  if (typeof title !== 'string' || !title.trim()) bad('title must be a non-empty string')
  if (Buffer.byteLength(title) > MAX_TITLE_BYTES) bad(`title must be at most ${MAX_TITLE_BYTES} bytes as UTF-8`)
  if (body !== undefined && typeof body !== 'string') bad('body must be a string')
  if (typeof body === 'string' && Buffer.byteLength(body) > MAX_BODY_BYTES) {
    bad(`body must be at most ${MAX_BODY_BYTES} bytes as UTF-8`)
  }
  const parsedActions: ParsedNotification['actions'] = []
  if (actions !== undefined) {
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) bad(`actions must be a list of at most ${MAX_ACTIONS}`)
    for (const action of actions) {
      if (!isObject(action) || typeof action.id !== 'string' || !ACTION_ID.test(action.id)) {
        bad('Each action needs an id of letters, digits, "-" and "_" (at most 64)')
      }
      if (typeof action.title !== 'string' || !action.title.trim() || action.title.length > 64) {
        bad('Each action needs a title of at most 64 characters')
      }
      if (parsedActions.some((a) => a.id === action.id)) bad(`Action id "${action.id}" is used twice`)
      parsedActions.push({ id: action.id, title: action.title })
    }
  }
  if (data !== undefined && Buffer.byteLength(JSON.stringify(data) ?? '') > MAX_DATA_BYTES) {
    bad(`data must be at most ${MAX_DATA_BYTES} bytes as JSON`)
  }
  return { title, ...(typeof body === 'string' ? { body } : {}), actions: parsedActions, ...(data !== undefined ? { data } : {}) }
}

function appNotification(id: string, project: string, n: ParsedNotification) {
  return { id, project, title: n.title, ...(n.body !== undefined ? { body: n.body } : {}), actions: n.actions }
}

export function pushPayload(id: string, project: string, n: ParsedNotification) {
  return {
    aps: {
      alert: { title: n.title, ...(n.body !== undefined ? { body: n.body } : {}) },
      sound: 'default',
      'thread-id': project,
      // Actions differ per notification, so the app's notification service
      // extension registers a category with this ID from hobwork.actions
      // before iOS shows it.
      ...(n.actions.length ? { category: `hobwork.${id}`, 'mutable-content': 1 } : {}),
    },
    // Title and body are in aps.alert only: repeating them here could take a
    // valid notification past APNs' 4 KB.
    hobwork: { id, project, actions: n.actions },
  }
}

// JSON escaping can make fields within their limits too large together, so
// the payload itself is measured. This runs before any delivery, so every
// notification that is accepted can also go by push.
function checkPushSize(project: string, n: ParsedNotification) {
  const size = Buffer.byteLength(JSON.stringify(pushPayload(SAMPLE_ID, project, n)))
  if (size > MAX_PAYLOAD_BYTES) {
    throw new DeviceError(
      'too_large',
      `The notification is ${size} bytes as a push, and Apple allows ${MAX_PAYLOAD_BYTES}. Shorten the title, body or action titles`,
    )
  }
}

export type Devices = ReturnType<typeof createDevices>

export function createDevices(options: {
  host: Host
  apns?: Apns
  // Devices of people no longer on it are hidden from projects.
  allowlist?: Allowlist
  registry?: DeviceRegistry
  // The deployed version's device triggers of a project, from hobwork.json.
  triggers?: (project: string) => Promise<Record<string, { device?: DeviceTrigger }>>
  invokeTrigger?: (project: string, name: string, payload: NotificationActionEvent) => Promise<unknown>
}) {
  const { host, apns } = options
  const registry = options.registry ?? createDeviceRegistry()
  const closers: (() => void)[] = []

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
      capabilities: device.capabilities,
      connected: registry.connected(device.id),
      lastSeenAt: device.lastSeenAt,
      appVersion: device.appVersion,
      push: device.push !== null,
      createdAt: device.createdAt,
      ownerAllowed: ownerAllowed(device),
    }
  }

  function projectLog(project: string, level: 'info' | 'warn', message: string) {
    try {
      appendLog(host, { project, source: 'runtime', level, event: 'trigger', message })
    } catch (err) {
      console.error(`Could not record a device event for ${project}`, err)
    }
  }

  async function sendNotification(project: string, deviceName: string, args: unknown): Promise<SentNotification> {
    const device = typeof deviceName === 'string' ? findDeviceByName(host.db, deviceName) : undefined
    if (!reachable(device)) {
      const names = listDevices(host.db)
        .filter(ownerAllowed)
        .map((d) => d.name)
      throw new DeviceError(
        'unknown_device',
        `No device called ${JSON.stringify(deviceName)}. ${names.length ? `Paired devices: ${names.join(', ')}` : 'No device is paired with Hobwork yet'}`,
      )
    }
    if (!device.capabilities.includes('notifications')) {
      throw new DeviceError('unsupported', `${device.name} has not said it can show notifications. Open the Hobwork app on it and allow notifications`)
    }
    const notification = parseNotification(args)
    const projectRow = getProject(host, project)
    if (!projectRow) throw new DeviceError('bad_request', `Project "${project}" does not exist`)
    checkPushSize(project, notification)
    const id = recordNotification(host.db, {
      deviceId: device.id,
      projectId: projectRow.id,
      actions: notification.actions.map((a) => a.id),
      data: notification.data,
    })

    let socketError: DeviceError | undefined
    if (registry.connected(device.id)) {
      try {
        await registry.call(device.id, 'notifications', 'send', appNotification(id, project, notification))
        return { id, delivery: 'app' }
      } catch (err) {
        if (!(err instanceof DeviceError) || !TRANSPORT_ERRORS.has(err.code)) throw err
        socketError = err
      }
    }
    const offline = socketError ? `${device.name} did not answer (${socketError.message})` : `${device.name} is not connected`
    if (!apns) throw new DeviceError('unreachable', `${offline}, and push notifications are not set up on this Hobwork host`)
    if (!device.push) throw new DeviceError('unreachable', `${offline}, and it has not registered for push notifications`)
    let result
    try {
      result = await apns.send(device.push, { id, payload: pushPayload(id, project, notification) })
    } catch (err) {
      if (err instanceof PayloadTooLarge) throw new DeviceError('too_large', err.message)
      throw new DeviceError('push_failed', `Could not reach Apple's push service for ${device.name}: ${(err as Error).message}`)
    }
    if (!result.ok) {
      if (result.tokenGone) setPushToken(host.db, device.id, null)
      throw new DeviceError('push_failed', `Apple's push service refused the notification for ${device.name}: ${result.reason}`)
    }
    return { id, delivery: 'push' }
  }

  // Events the app sends over its socket or POST /api/devices/events.
  // Unknown ones are ignored, so older hosts work with newer apps. Resolves
  // once the triggers started, not when they finish: a handler may run for
  // minutes, and iOS gives an app woken for an action a few seconds. An action
  // no trigger took stays unanswered, so a retry from the app can still run it.
  async function handleEvent(deviceId: number, event: AppEvent): Promise<void> {
    if (event.capability !== 'notifications' || event.name !== 'action' || !isObject(event.data)) return
    const { id, action } = event.data
    if (typeof id !== 'string' || typeof action !== 'string') return
    const device = getDevice(host.db, deviceId)
    if (!reachable(device)) return
    const record = findNotification(host.db, id, deviceId, action)
    if (!record) return
    let entries: Record<string, { device?: DeviceTrigger }>
    try {
      entries = (await options.triggers?.(record.project)) ?? {}
    } catch (err) {
      projectLog(
        record.project,
        'warn',
        `${device.name}: action "${action}" was tapped, but the project's triggers could not be read: ${(err as Error).message}`,
      )
      return
    }
    const triggers = Object.entries(entries).filter(
      ([, entry]) => entry.device?.capability === 'notifications' && entry.device.event === 'action',
    )
    if (!triggers.length) {
      projectLog(
        record.project,
        'warn',
        `${device.name}: action "${action}" was tapped on a notification, but no trigger handles notification actions. Add one with "device": { "capability": "notifications", "event": "action" } to hobwork.json`,
      )
      return
    }
    if (!answerNotification(host.db, id)) return
    const payload: NotificationActionEvent = {
      device: device.name,
      capability: 'notifications',
      event: 'action',
      notificationId: id,
      action,
      ...(record.data !== undefined ? { data: record.data } : {}),
    }
    for (const [name] of triggers) {
      Promise.resolve()
        .then(() => options.invokeTrigger?.(record.project, name, payload))
        .catch((err: unknown) =>
          projectLog(record.project, 'warn', `Running trigger "${name}" for a notification action failed: ${(err as Error).message}`),
        )
    }
  }

  return {
    registry,
    pushEnabled: Boolean(apns),
    ownerAllowed,
    list: (): DeviceSummary[] => listDevices(host.db).map(summary),
    info: (): DeviceInfo[] =>
      listDevices(host.db)
        .filter(reachable)
        .map((d) => {
          const { name, platform, owner, capabilities, connected, lastSeenAt } = summary(d)
          return { name, platform, owner, capabilities, connected, lastSeenAt }
        }),
    sendNotification,
    handleEvent,
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
      registry.closeAll(1001, 'Hobwork is shutting down')
      for (const closer of closers) closer()
      apns?.close()
    },
  }
}
