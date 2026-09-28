import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

type Message = { id: number; type: string; [key: string]: unknown }

export type FakeSubscription = { socket: WebSocket; id: number; trigger: unknown }

// A stand-in for the Home Assistant WebSocket API, just enough to test the
// client's protocol handling.
export type FakeHomeAssistant = {
  url: string
  token: string
  received: Message[]
  subscriptions: FakeSubscription[]
  authenticated: number
  // Message types the server receives but never answers.
  silent: Set<string>
  responses: Map<string, (message: Message) => unknown>
  failures: Map<string, { code: string; message: string }>
  fire(variables: Record<string, unknown>, match?: (s: FakeSubscription) => boolean): number
  dropConnections(): void
  close(): Promise<void>
}

export async function startFakeHomeAssistant(
  options: { token?: string; port?: number } = {},
): Promise<FakeHomeAssistant> {
  const wss = new WebSocketServer({ port: options.port ?? 0, host: '127.0.0.1', path: '/api/websocket' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))

  const fake: FakeHomeAssistant = {
    url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    token: options.token ?? 'test-token',
    received: [],
    subscriptions: [],
    authenticated: 0,
    silent: new Set(),
    responses: new Map(),
    failures: new Map(),
    fire(variables, match = () => true) {
      const targets = fake.subscriptions.filter(match)
      for (const s of targets) {
        s.socket.send(JSON.stringify({ id: s.id, type: 'event', event: { variables, context: { id: 'ctx', parent_id: null, user_id: null } } }))
      }
      return targets.length
    },
    dropConnections() {
      for (const socket of wss.clients) socket.terminate()
      fake.subscriptions = []
    },
    close() {
      for (const socket of wss.clients) socket.terminate()
      return new Promise((resolve) => wss.close(() => resolve()))
    },
  }

  wss.on('connection', (socket) => {
    let authed = false
    socket.send(JSON.stringify({ type: 'auth_required', ha_version: 'fake' }))
    socket.on('close', () => {
      fake.subscriptions = fake.subscriptions.filter((s) => s.socket !== socket)
    })
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Message
      if (!authed) {
        if (message.type === 'auth' && message.access_token === fake.token) {
          authed = true
          fake.authenticated++
          socket.send(JSON.stringify({ type: 'auth_ok', ha_version: 'fake' }))
        } else {
          socket.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token or password' }))
          socket.close()
        }
        return
      }
      fake.received.push(message)
      if (fake.silent.has(message.type)) return
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result }))
      const fail = (code: string, text: string) =>
        socket.send(JSON.stringify({ id: message.id, type: 'result', success: false, error: { code, message: text } }))

      const failure = fake.failures.get(message.type)
      if (failure) return fail(failure.code, failure.message)
      const custom = fake.responses.get(message.type)
      if (custom) return reply(custom(message))
      switch (message.type) {
        case 'ping':
          return socket.send(JSON.stringify({ id: message.id, type: 'pong' }))
        case 'subscribe_trigger': {
          const trigger = message.trigger as Record<string, unknown>
          if (trigger.trigger === 'bogus') return fail('invalid_format', "Invalid trigger 'bogus' specified")
          fake.subscriptions.push({ socket, id: message.id, trigger })
          return reply(null)
        }
        case 'unsubscribe_events': {
          const before = fake.subscriptions.length
          fake.subscriptions = fake.subscriptions.filter((s) => !(s.socket === socket && s.id === message.subscription))
          if (fake.subscriptions.length === before) return fail('not_found', 'Subscription not found.')
          return reply(null)
        }
        default:
          return fail('unknown_command', 'Unknown command.')
      }
    })
  })

  return fake
}
