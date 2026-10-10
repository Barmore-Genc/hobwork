import type { DeviceDelivery } from '../../../packages/sdk/src/devices.ts'
import type { DeviceRequest, DeviceResponse } from '../../../packages/sdk/src/runner/protocol.ts'
import type { Devices } from './devices.ts'
import { DeviceError } from './registry.ts'

// Deployed handlers use devices. Workspaces and branch previews run work in
// progress, and a test that notifies someone's phone has real effects, so
// they only list devices.
export type DeviceAccess = 'full' | 'read'

export type DeviceCallLog = {
  invocation?: number
  level: 'debug' | 'info' | 'warn'
  message: string
}

const STATUS_BY_CODE: Record<string, number> = {
  bad_request: 400,
  read_only: 403,
  unknown_device: 404,
  unknown_person: 404,
  unsupported: 422,
  unreachable: 503,
  not_connected: 503,
  disconnected: 503,
  timeout: 504,
  too_large: 413,
  push_failed: 502,
}

const HOW = { app: ' (to the app)', push: ' (by push)', scheduled: '' }

// What a command log line says about how it went.
function describe(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

function answer(response: DeviceResponse, status = 200): Response {
  return Response.json(response, { status })
}

function failure(code: string, message: string): Response {
  return answer({ ok: false, error: { code, message } }, STATUS_BY_CODE[code] ?? 502)
}

export async function devicesResponse(
  body: string,
  options: { devices?: Devices; project: string; access: DeviceAccess; log?: (entry: DeviceCallLog) => void },
): Promise<Response> {
  let request: DeviceRequest
  try {
    request = JSON.parse(body) as DeviceRequest
  } catch {
    return failure('bad_request', 'Body must be JSON')
  }
  if (typeof request !== 'object' || request === null) return failure('bad_request', 'Body must be an object')
  const invocation = typeof request.invocation === 'number' ? request.invocation : undefined
  const { devices } = options
  if (!devices) return failure('unreachable', 'This Hobwork host has no devices')
  if (request.action === 'people') return answer({ ok: true, result: devices.people() })
  if (request.action === 'list') {
    if (request.person === undefined) return answer({ ok: true, result: devices.info() })
    const owned = Number.isSafeInteger(request.person) ? devices.personDevices(request.person) : undefined
    if (!owned) return failure('unknown_person', `No person with ID ${JSON.stringify(request.person)}. ctx.people() lists them`)
    return answer({ ok: true, result: owned })
  }
  if (!['call', 'notify', 'updateNotification', 'withdrawNotification'].includes(request.action)) {
    return failure('bad_request', `Unknown action ${JSON.stringify((request as { action?: unknown }).action)}`)
  }
  if (options.access === 'read') {
    return failure(
      'read_only',
      'Workspaces and branch previews cannot use devices. Deployed handlers can; in tests, fake ctx.device with createTestContext',
    )
  }
  if (request.action !== 'call') return notificationResponse(request, devices, options.project, invocation, options.log)

  const what = `${request.capability}.${request.method} on ${JSON.stringify(request.device)}`
  try {
    if (request.capability !== 'notifications' || request.method !== 'send') {
      const value = await devices.callCommand(options.project, request.device, request.capability, request.method, request.args, invocation)
      options.log?.({ invocation, level: 'info', message: `Device ${request.device}: ${request.capability}.${request.method} answered ${describe(value)}` })
      return answer({ ok: true, result: value })
    }
    const sent = await devices.sendNotification(options.project, request.device, request.args)
    const title = (request.args as { title?: unknown }).title
    options.log?.({
      invocation,
      level: 'info',
      message: `Device ${request.device}: ${sent.delivery === 'scheduled' ? 'scheduled' : 'sent'} notification ${JSON.stringify(title)}${HOW[sent.delivery]}`,
    })
    return answer({ ok: true, result: sent })
  } catch (err) {
    const code = err instanceof DeviceError ? err.code : 'unknown_error'
    const message = err instanceof Error ? err.message : String(err)
    if (!(err instanceof DeviceError)) console.error(`Device call ${what} failed`, err)
    options.log?.({ invocation, level: 'warn', message: `Device: ${what} failed: ${message}` })
    return failure(code, message)
  }
}

type NotificationRequest = Extract<DeviceRequest, { action: 'notify' | 'updateNotification' | 'withdrawNotification' }>

function deliveries(results: DeviceDelivery[]): string {
  return results.map((r) => ('error' in r ? `${r.device}: ${r.error.code}` : `${r.device}${HOW[r.delivery]}`)).join(', ')
}

async function notificationResponse(
  request: NotificationRequest,
  devices: Devices,
  project: string,
  invocation: number | undefined,
  log?: (entry: DeviceCallLog) => void,
): Promise<Response> {
  const what =
    request.action === 'notify' ? `Notifying person ${JSON.stringify(request.person)}` : `${request.action === 'updateNotification' ? 'Updating' : 'Withdrawing'} notification ${JSON.stringify(request.id)}`
  try {
    if (request.action === 'notify') {
      if (!Number.isSafeInteger(request.person)) return failure('unknown_person', `No person with ID ${JSON.stringify(request.person)}. ctx.people() lists them`)
      const sent = await devices.notifyPerson(project, request.person, request.args)
      const title = (request.args as { title?: unknown } | undefined)?.title
      log?.({
        invocation,
        level: sent.devices.some((d) => 'error' in d) ? 'warn' : 'info',
        message: sent.scheduled
          ? `Scheduled notification ${JSON.stringify(title)} for person ${request.person}`
          : `Sent notification ${JSON.stringify(title)} to person ${request.person}: ${deliveries(sent.devices)}`,
      })
      return answer({ ok: true, result: sent })
    }
    if (request.action === 'updateNotification') {
      const updated = await devices.updateNotification(project, request.id, request.args)
      log?.({
        invocation,
        level: 'info',
        message: updated.updated ? `Updated notification ${JSON.stringify(request.id)}${updated.devices.length ? `: ${deliveries(updated.devices)}` : ''}` : `Notification ${JSON.stringify(request.id)} was not updated: it is not showing`,
      })
      return answer({ ok: true, result: updated })
    }
    const withdrawn = await devices.withdrawNotification(project, request.id)
    log?.({
      invocation,
      level: 'info',
      message: withdrawn.withdrawn ? `Withdrew notification ${JSON.stringify(request.id)}` : `Notification ${JSON.stringify(request.id)} was already withdrawn or never sent`,
    })
    return answer({ ok: true, result: withdrawn })
  } catch (err) {
    const code = err instanceof DeviceError ? err.code : 'unknown_error'
    const message = err instanceof Error ? err.message : String(err)
    if (!(err instanceof DeviceError)) console.error(`${what} failed`, err)
    log?.({ invocation, level: 'warn', message: `${what} failed: ${message}` })
    return failure(code, message)
  }
}
