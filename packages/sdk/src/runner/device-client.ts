import type { Device, DeviceInfo, NotificationControl } from '../devices.ts'
import type { LiveActivityControl } from '../live-activities.ts'
import type { Person, PersonDevices } from '../people.ts'
import { internalPost } from './internal-fetch.ts'
import type { DeviceRequest, DeviceResponse } from './protocol.ts'

// The runner and the handler bundle each have their own copy of this class, so
// instanceof checks a brand instead of the prototype chain.
const BRAND = Symbol.for('hobwork.DeviceError')

export class DeviceError extends Error {
  // "unknown_device", "unknown_person", "unsupported" (the app cannot do this), "unreachable"
  // (not connected and no push), "timeout" (a command may still run until it
  // expires), "push_failed", "too_large", "read_only" (workspaces and branch
  // previews), "bad_request", or the app's own code, such as "not_authorized".
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DeviceError'
    this.code = code
    Object.defineProperty(this, BRAND, { value: true })
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type DeviceSend = (request: DistributiveOmit<DeviceRequest, 'invocation'>) => Promise<DeviceResponse>

export type DeviceClient = {
  device(name: string): Device
  devices(): Promise<DeviceInfo[]>
  people(): Promise<Person[]>
  person(id: number): PersonDevices
  notifications: NotificationControl
  liveActivities: LiveActivityControl
}

type Target = { device: string } | { person: number } | Record<string, never>

export function createDeviceClient(send: DeviceSend): DeviceClient {
  async function call<T>(request: DistributiveOmit<DeviceRequest, 'invocation'>): Promise<T> {
    const response = await send(request)
    if (!response.ok) throw new DeviceError(response.error.code, response.error.message)
    return response.result as T
  }

  function liveActivities(target: Target) {
    return {
      start: (args: { id?: unknown }) => call<never>({ action: 'liveActivity', op: 'start', ...target, args }),
      update: (id: string, args: unknown) => call<never>({ action: 'liveActivity', op: 'update', ...target, id, args }),
      end: (id: string, args?: unknown) => call<never>({ action: 'liveActivity', op: 'end', ...target, id, args: args ?? {} }),
    }
  }

  function widgets(target: Target) {
    return { reload: () => call<never>({ action: 'reloadWidgets', ...target }) }
  }

  function device(deviceName: string): Device {
    const method =
      (capability: string, name: string) =>
      (args?: unknown): Promise<never> =>
        call({ action: 'call', device: deviceName, capability, method: name, args })
    return {
      notifications: { send: method('notifications', 'send') },
      alarms: {
        set: method('alarms', 'set'),
        timer: method('alarms', 'timer'),
        reschedule: method('alarms', 'reschedule'),
        cancel: method('alarms', 'cancel'),
        list: method('alarms', 'list'),
      },
      screenTime: {
        sets: method('screenTime', 'sets'),
        block: method('screenTime', 'block'),
        unblock: method('screenTime', 'unblock'),
        schedule: method('screenTime', 'schedule'),
        removeSchedule: method('screenTime', 'removeSchedule'),
        limit: method('screenTime', 'limit'),
        removeLimit: method('screenTime', 'removeLimit'),
        status: method('screenTime', 'status'),
      },
      focus: { status: method('focus', 'status') },
      nfc: { write: method('nfc', 'write'), read: method('nfc', 'read') },
      health: { query: method('health', 'query') },
      liveActivities: liveActivities({ device: deviceName }),
      widgets: widgets({ device: deviceName }),
    }
  }

  function person(id: number): PersonDevices {
    const devices = () => call<DeviceInfo[]>({ action: 'list', person: id })
    return {
      devices,
      lastActiveDevice: async () => (await devices())[0],
      notifications: { send: (args) => call({ action: 'notify', person: id, args }) },
      liveActivities: liveActivities({ person: id }),
      widgets: widgets({ person: id }),
    }
  }

  return {
    device,
    devices: () => call<DeviceInfo[]>({ action: 'list' }),
    people: () => call<Person[]>({ action: 'people' }),
    person,
    notifications: {
      update: (id, args) => call({ action: 'updateNotification', id, args }),
      withdraw: (id) => call({ action: 'withdrawNotification', id }),
    },
    liveActivities: liveActivities({}),
  }
}

export function httpDeviceSender(baseUrl: string, invocation?: () => number | undefined): DeviceSend {
  return async (request) => {
    const res = await internalPost(baseUrl, '/v1/devices', JSON.stringify({ ...request, invocation: invocation?.() }))
    const body = (await res.json().catch(() => undefined)) as DeviceResponse | { error?: string } | undefined
    if (body && 'ok' in body) return body
    throw new DeviceError('host_error', `The host could not handle the device call: HTTP ${res.status}${body?.error ? ` ${body.error}` : ''}`)
  }
}
