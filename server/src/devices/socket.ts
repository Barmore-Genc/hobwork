import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import { WebSocketServer, type WebSocket } from 'ws'
import { isAllowed } from '../auth/users.ts'
import { publishChange } from '../changes.ts'
import type { Allowlist } from '../config.ts'
import { refuseUpgrade } from '../http.ts'
import type { Devices } from './devices.ts'
import { CLOSE_OWNER_NOT_ALLOWED, CLOSE_PROTOCOL_ERROR, CLOSE_REVOKED, CLOSE_TIMEOUT, type DeviceConnection, type HostMessage } from './registry.ts'
import { getDevice, recordHello, touchDevice, verifyDeviceToken, type Device, type Push } from './store.ts'

export const DEVICE_SOCKET_PATH = '/api/devices/ws'
export const PING_INTERVAL_MS = 30_000
// A connection that does not say hello is not a Hobwork app.
const HELLO_TIMEOUT_MS = 30_000
const MAX_MESSAGE_BYTES = 1024 * 1024
// last_seen_at is written at most this often while a device stays connected.
const TOUCH_INTERVAL_MS = 60_000
const MAX_CAPABILITIES = 32

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePush(value: unknown): Push | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!isObject(value)) return undefined
  const { token, environment } = value
  if (typeof token !== 'string' || !/^[0-9A-Fa-f]{16,200}$/.test(token)) return undefined
  if (environment !== 'sandbox' && environment !== 'production') return undefined
  return { token: token.toLowerCase(), environment }
}

export type DeviceAuth = { device: Device } | { refused: { status: 401 | 403; error: string } }

export const UNKNOWN_DEVICE = { status: 401, error: 'Send a device token of a paired device as Authorization: Bearer' } as const
// A separate answer from 401, so the app keeps its token: the device works
// again once the owner is back on the allowlist.
export const OWNER_NOT_ALLOWED = { status: 403, error: 'not_allowed' } as const

// The device behind `Authorization: Bearer hwd_...`, while its owner may still
// sign in.
export function deviceFromRequest(db: DatabaseSync, allowlist: Allowlist, req: IncomingMessage): DeviceAuth {
  const header = req.headers.authorization
  const device = header?.startsWith('Bearer ') ? verifyDeviceToken(db, header.slice('Bearer '.length).trim()) : undefined
  if (!device) return { refused: UNKNOWN_DEVICE }
  if (!ownerMaySignIn(db, allowlist, device)) return { refused: OWNER_NOT_ALLOWED }
  return { device }
}

function ownerMaySignIn(db: DatabaseSync, allowlist: Allowlist, device: Device): boolean {
  return isAllowed(db, allowlist, { id: device.userId, name: device.owner, email: device.ownerEmail })
}

export type DeviceSockets = ReturnType<typeof createDeviceSockets>

// The app's WebSocket (see "Device protocol" in docs/architecture.md).
export function createDeviceSockets(options: {
  db: DatabaseSync
  allowlist: Allowlist
  devices: Devices
  pingIntervalMs?: number
  now?: () => number
}) {
  const { db, allowlist, devices } = options
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS
  const now = options.now ?? Date.now
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  // Upgraded sockets keep the HTTP server from closing, so shutting down has
  // to end them first.
  devices.onClose(() => {
    for (const client of wss.clients) client.terminate()
  })

  function serve(ws: WebSocket, device: Device) {
    const deviceId = device.id
    let helloed = false
    let missed = 0
    let lastTouch = 0
    const connection: DeviceConnection = {
      deviceId,
      send: (message: HostMessage) => ws.send(JSON.stringify(message)),
      close: (code, reason) => ws.close(code, reason),
    }
    const send = (message: HostMessage) => {
      if (ws.readyState === ws.OPEN) connection.send(message)
    }

    const helloTimer = setTimeout(() => ws.close(CLOSE_PROTOCOL_ERROR, 'Send hello first'), HELLO_TIMEOUT_MS)
    // Both sides ping every interval. Any message counts as a sign of life, so
    // a busy connection is never dropped for a late pong.
    const pinger = setInterval(() => {
      if (missed >= 2) {
        ws.close(CLOSE_TIMEOUT, 'No answer to two pings')
        ws.terminate()
        return
      }
      // Taking someone off the allowlist needs no host restart, so an open
      // socket is checked again here.
      const current = getDevice(db, deviceId)
      if (!current) return ws.close(CLOSE_REVOKED, 'This device was removed from Hobwork')
      if (!ownerMaySignIn(db, allowlist, current)) {
        return ws.close(CLOSE_OWNER_NOT_ALLOWED, 'The owner of this device can no longer sign in')
      }
      missed++
      send({ type: 'ping' })
    }, pingIntervalMs)

    function alive() {
      missed = 0
      if (helloed && now() - lastTouch > TOUCH_INTERVAL_MS) {
        lastTouch = now()
        touchDevice(db, deviceId, lastTouch)
      }
    }

    function hello(message: Record<string, unknown>) {
      const capabilities = Array.isArray(message.capabilities)
        ? [...new Set(message.capabilities.filter((c): c is string => typeof c === 'string' && c.length <= 64))].slice(0, MAX_CAPABILITIES)
        : []
      const push = parsePush(message.push)
      // A device revoked while it was connecting must not come back.
      if (!getDevice(db, deviceId)) return ws.close(CLOSE_PROTOCOL_ERROR, 'This device was removed from Hobwork')
      lastTouch = now()
      recordHello(
        db,
        deviceId,
        {
          appVersion: typeof message.appVersion === 'string' ? message.appVersion.slice(0, 64) : null,
          capabilities,
          ...(push !== undefined ? { push } : {}),
        },
        lastTouch,
      )
      clearTimeout(helloTimer)
      if (!helloed) devices.registry.attach(connection)
      helloed = true
      devices.resendPending(deviceId)
    }

    ws.on('message', (raw, isBinary) => {
      alive()
      let message: unknown
      try {
        message = JSON.parse(isBinary ? Buffer.from(raw as Buffer).toString('utf8') : raw.toString())
      } catch {
        return ws.close(CLOSE_PROTOCOL_ERROR, 'Messages must be JSON')
      }
      if (!isObject(message)) return ws.close(CLOSE_PROTOCOL_ERROR, 'Messages must be JSON objects')
      switch (message.type) {
        case 'hello':
          return hello(message)
        case 'result':
          if (devices.registry.result(connection, message as { id: unknown; ok: unknown })) return
          return void devices.handleResult(deviceId, message)
        case 'event':
          return void devices
            .handleEvent(deviceId, { capability: message.capability, name: message.name, data: message.data })
            .catch((err: unknown) => console.error(`Handling an event from device ${deviceId} failed`, err))
        case 'ping':
          return send({ type: 'pong' })
        default:
          // pong, and message types from newer apps.
          return
      }
    })
    ws.on('pong', alive)
    ws.on('close', () => {
      clearTimeout(helloTimer)
      clearInterval(pinger)
      devices.registry.detach(connection)
      if (helloed) publishChange(db, { kind: 'devices' })
      try {
        if (helloed && getDevice(db, deviceId)) touchDevice(db, deviceId, now())
      } catch (err) {
        // The host DB is closed when connections end during shutdown.
        console.warn(`Could not record when device ${deviceId} was last seen: ${(err as Error).message}`)
      }
    })
    ws.on('error', (err) => console.warn(`Device ${deviceId} connection error: ${err.message}`))
  }

  return {
    // Returns false for upgrade requests to other paths.
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== DEVICE_SOCKET_PATH) return false
      const auth = deviceFromRequest(db, allowlist, req)
      if ('refused' in auth) {
        refuseUpgrade(socket, auth.refused.status, auth.refused.error)
        return true
      }
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws, auth.device))
      return true
    },
    close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
  }
}
