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
  unsupported: 422,
  unreachable: 503,
  not_connected: 503,
  disconnected: 503,
  timeout: 504,
  too_large: 413,
  push_failed: 502,
}

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
  if (request.action === 'list') return answer({ ok: true, result: devices.info() })
  if (request.action !== 'call') return failure('bad_request', `Unknown action ${JSON.stringify((request as { action?: unknown }).action)}`)

  const what = `${request.capability}.${request.method} on ${JSON.stringify(request.device)}`
  if (options.access === 'read') {
    return failure(
      'read_only',
      'Workspaces and branch previews cannot use devices. Deployed handlers can; in tests, fake ctx.device with createTestContext',
    )
  }
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
      message: `Device ${request.device}: sent notification ${JSON.stringify(title)} (${sent.delivery === 'app' ? 'to the app' : 'by push'})`,
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
