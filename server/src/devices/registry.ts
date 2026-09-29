import { randomUUID } from 'node:crypto'

// Codes the host itself answers with. Apps answer failed calls with their own.
export type DeviceErrorCode =
  | 'not_connected'
  | 'disconnected'
  | 'timeout'
  | 'unknown_device'
  | 'unsupported'
  | 'unreachable'
  | 'read_only'
  | 'bad_request'
  | 'push_failed'
  | (string & {})

export class DeviceError extends Error {
  code: DeviceErrorCode
  constructor(code: DeviceErrorCode, message: string) {
    super(message)
    this.name = 'DeviceError'
    this.code = code
  }
}

export type HostMessage =
  | { type: 'call'; id: string; capability: string; method: string; args: unknown }
  | { type: 'ping' }
  | { type: 'pong' }

// WebSocket close codes the host uses. 4000-4999 are for applications.
export const CLOSE_REPLACED = 4000
export const CLOSE_REVOKED = 4001
export const CLOSE_PROTOCOL_ERROR = 4002
export const CLOSE_TIMEOUT = 4003
export const CLOSE_OWNER_NOT_ALLOWED = 4004

export type DeviceConnection = {
  deviceId: number
  send(message: HostMessage): void
  close(code: number, reason: string): void
}

type Pending = {
  connection: DeviceConnection
  resolve: (value: unknown) => void
  reject: (err: DeviceError) => void
  timer: NodeJS.Timeout
}

export const DEFAULT_CALL_TIMEOUT_MS = 15_000

export type DeviceRegistry = ReturnType<typeof createDeviceRegistry>

export function createDeviceRegistry(options: { callTimeoutMs?: number } = {}) {
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const connections = new Map<number, DeviceConnection>()
  const pending = new Map<string, Pending>()
  const detachListeners: ((connection: DeviceConnection) => void)[] = []

  function settle(id: string): Pending | undefined {
    const call = pending.get(id)
    if (!call) return undefined
    pending.delete(id)
    clearTimeout(call.timer)
    return call
  }

  // Calls still waiting on this connection fail, since their results can no
  // longer arrive.
  function detach(connection: DeviceConnection) {
    if (connections.get(connection.deviceId) === connection) connections.delete(connection.deviceId)
    for (const listener of detachListeners) listener(connection)
    for (const [id, call] of pending) {
      if (call.connection !== connection) continue
      settle(id)
      call.reject(new DeviceError('disconnected', 'The device disconnected before it answered'))
    }
  }

  function disconnect(deviceId: number, code: number, reason: string) {
    const connection = connections.get(deviceId)
    if (!connection) return
    detach(connection)
    connection.close(code, reason)
  }

  return {
    // A device that connects again replaces its old connection, which may be
    // half-open after the phone changed networks.
    attach(connection: DeviceConnection) {
      const old = connections.get(connection.deviceId)
      connections.set(connection.deviceId, connection)
      if (old && old !== connection) {
        detach(old)
        old.close(CLOSE_REPLACED, 'Replaced by a newer connection')
      }
    },

    detach,

    connected(deviceId: number): boolean {
      return connections.has(deviceId)
    },

    connectedIds(): number[] {
      return [...connections.keys()]
    },

    disconnect,

    onDetach(listener: (connection: DeviceConnection) => void) {
      detachListeners.push(listener)
    },

    // Sends without waiting for a result, for commands, whose results can
    // arrive on any connection or by HTTP. Returns the connection it went to.
    send(deviceId: number, message: HostMessage): DeviceConnection | undefined {
      const connection = connections.get(deviceId)
      if (!connection) return undefined
      try {
        connection.send(message)
      } catch (err) {
        throw new DeviceError('disconnected', `Sending to the device failed: ${(err as Error).message}`)
      }
      return connection
    },

    call(deviceId: number, capability: string, method: string, args: unknown, timeoutMs = callTimeoutMs): Promise<unknown> {
      const connection = connections.get(deviceId)
      if (!connection) return Promise.reject(new DeviceError('not_connected', 'The device is not connected'))
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (settle(id)) reject(new DeviceError('timeout', `The device did not answer within ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        pending.set(id, { connection, resolve, reject, timer })
        try {
          connection.send({ type: 'call', id, capability, method, args })
        } catch (err) {
          settle(id)
          reject(new DeviceError('disconnected', `Sending to the device failed: ${(err as Error).message}`))
        }
      })
    },

    // A result for a call this connection did not get is ignored, so one
    // device cannot answer another's calls. False when it is not one of this
    // registry's calls, such as a command's result.
    result(connection: DeviceConnection, message: { id: unknown; ok: unknown; value?: unknown; error?: unknown }): boolean {
      if (typeof message.id !== 'string' || !pending.has(message.id)) return false
      if (pending.get(message.id)!.connection !== connection) return true
      const call = settle(message.id)!
      if (message.ok === true) {
        call.resolve(message.value)
        return true
      }
      const error = (typeof message.error === 'object' && message.error !== null ? message.error : {}) as Record<string, unknown>
      call.reject(
        new DeviceError(
          typeof error.code === 'string' && error.code ? error.code : 'device_error',
          typeof error.message === 'string' && error.message ? error.message : 'The device reported an error',
        ),
      )
      return true
    },

    closeAll(code: number, reason: string) {
      for (const deviceId of connections.keys()) disconnect(deviceId, code, reason)
    },
  }
}
