import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { DeviceEvent } from '../../../packages/sdk/src/devices.ts'
import { createProject } from '../projects.ts'
import { queryLogs } from '../runtime/logs.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'
import { createDevices, type Devices } from './devices.ts'
import { CLOSE_OWNER_NOT_ALLOWED, CLOSE_PROTOCOL_ERROR, CLOSE_REVOKED, CLOSE_TIMEOUT, createDeviceRegistry } from './registry.ts'
import { createDeviceSockets, type DeviceSockets } from './socket.ts'
import { getDevice } from './store.ts'
import { pairDevice } from './test-devices.ts'

vi.setConfig({ testTimeout: 15_000 })

type Message = Record<string, unknown>

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string
let devices: Devices
let invoked: { project: string; name: string; payload: DeviceEvent }[]
let triggers: Record<string, { device?: { capability: 'notifications'; event: 'action' } }>
let sockets: DeviceSockets | undefined
let server: Server | undefined
let allowlist: { emails: string[]; subjects: string[] }

beforeEach(async () => {
  host = createTestHost()
  cookie = signedIn(host).cookie
  invoked = []
  allowlist = { emails: ['kaan@example.com'], subjects: [] }
  triggers = { snooze: { device: { capability: 'notifications', event: 'action' } }, desk: {} }
  devices = createDevices({
    host,
    allowlist,
    registry: createDeviceRegistry({ callTimeoutMs: 500 }),
    triggers: async () => triggers,
    invokeTrigger: async (project, name, payload) => invoked.push({ project, name, payload }),
  })
  app = await startTestApp(host, { devices, web: { allowlist } })
  await createProject(host, 'alarms')
})

afterEach(async () => {
  sockets?.close()
  sockets = undefined
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  devices.close()
  await app.close()
  host.dispose()
})

// A socket server with a short ping interval, for the liveness tests.
async function startSockets(pingIntervalMs: number): Promise<string> {
  sockets = createDeviceSockets({ db: host.db, allowlist, devices, pingIntervalMs })
  server = createServer()
  server.on('upgrade', (req, socket, head) => {
    if (!sockets!.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
}

class AppClient {
  ws: WebSocket
  messages: Message[] = []
  waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = []
  closed: Promise<{ code: number; reason: string }>
  // Answers host pings like the app does, unless turned off.
  answerPings = true

  constructor(base: string, token: string) {
    this.ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/devices/ws`, { headers: { authorization: `Bearer ${token}` } })
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Message
      if (message.type === 'ping' && this.answerPings) this.send({ type: 'pong' })
      const waiter = this.waiters.find((w) => w.match(message))
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      } else this.messages.push(message)
    })
    this.closed = new Promise((resolve) => this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
  }

  send(message: Message) {
    this.ws.send(JSON.stringify(message))
  }

  next(match: (m: Message) => boolean): Promise<Message> {
    const found = this.messages.find(match)
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1)
      return Promise.resolve(found)
    }
    return new Promise((resolve) => this.waiters.push({ match, resolve }))
  }

  async hello(extra: Message = {}) {
    this.send({ type: 'hello', appVersion: '1.0 (1)', platform: 'ios', capabilities: ['notifications'], ...extra })
    await until(() => devices.list().some((d) => d.connected))
  }
}

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function connect(token: string, base = app.base): Promise<AppClient> {
  const client = new AppClient(base, token)
  await client.opened()
  return client
}

test('refuses connections without a valid device token', async () => {
  const client = new AppClient(app.base, 'hwd_nope')
  await expect(client.opened()).rejects.toThrow('401')
  const agent = new AppClient(app.base, 'hw_agent')
  await expect(agent.opened()).rejects.toThrow('401')
})

test('hello registers capabilities, push grant and connection, and the host answers with its push setup', async () => {
  const device = await pairDevice(app.base, cookie)
  const client = await connect(device.token)
  expect(devices.list()[0]).toMatchObject({ connected: false })
  const push = { grant: 'R3JhbnQtZm9yLXRoZS1hcHA', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  await client.hello({ push })
  expect(devices.list()[0]).toMatchObject({
    name: 'kaan-iphone',
    connected: true,
    capabilities: ['notifications'],
    appVersion: '1.0 (1)',
    push: false,
    lastSeenAt: expect.any(String),
  })
  expect(getDevice(host.db, device.deviceId)?.push).toEqual(push)
  expect(await client.next((m) => m.type === 'push')).toEqual({ type: 'push', relay: null })

  client.ws.close()
  await until(() => !devices.list()[0]!.connected)
})

test('notifications go over the socket when the app is connected', async () => {
  const device = await pairDevice(app.base, cookie)
  const client = await connect(device.token)
  await client.hello()

  const sent = devices.sendNotification('alarms', 'kaan-iphone', {
    title: 'Wake up',
    body: 'Alarm at 7:00',
    actions: [{ id: 'snooze', title: 'Snooze' }],
    data: { alarm: 3 },
  })
  const call = await client.next((m) => m.type === 'call')
  expect(call).toEqual({
    type: 'call',
    id: expect.any(String),
    capability: 'notifications',
    method: 'send',
    args: { id: expect.any(String), project: 'alarms', title: 'Wake up', body: 'Alarm at 7:00', actions: [{ id: 'snooze', title: 'Snooze' }] },
  })
  client.send({ type: 'result', id: call.id, ok: true, value: null })
  const notificationId = (call.args as { id: string }).id
  expect(await sent).toEqual({ id: notificationId, delivery: 'app' })

  // Tapping the action runs the project's device trigger once, with the data.
  const event = { type: 'event', capability: 'notifications', name: 'action', data: { id: notificationId, action: 'snooze' } }
  client.send(event)
  await until(() => invoked.length === 1)
  expect(invoked[0]).toEqual({
    project: 'alarms',
    name: 'snooze',
    payload: { device: 'kaan-iphone', capability: 'notifications', event: 'action', notificationId, action: 'snooze', data: { alarm: 3 } },
  })
  client.send(event)
  const again = await fetch(`${app.base}/api/devices/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  expect(again.status).toBe(204)
  await new Promise((r) => setTimeout(r, 100))
  expect(invoked).toHaveLength(1)
})

test('actions the notification did not have, and other devices, are ignored', async () => {
  const phone = await pairDevice(app.base, cookie)
  const laptop = await pairDevice(app.base, cookie, { name: 'kaan-mac', platform: 'macos' })
  const client = await connect(phone.token)
  await client.hello()
  const sent = devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi', actions: [{ id: 'ok', title: 'OK' }] })
  const call = await client.next((m) => m.type === 'call')
  client.send({ type: 'result', id: call.id, ok: true, value: null })
  const { id } = await sent

  const post = (token: string, data: unknown) =>
    fetch(`${app.base}/api/devices/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'notifications', name: 'action', data }),
    })
  await post(phone.token, { id, action: 'delete-everything' })
  await post(laptop.token, { id, action: 'ok' })
  await post(phone.token, { id: 'unknown', action: 'ok' })
  expect(invoked).toEqual([])
  await post(phone.token, { id, action: 'ok' })
  expect(invoked).toHaveLength(1)
})

test('an action with no trigger to run is logged in the project', async () => {
  triggers = {}
  const device = await pairDevice(app.base, cookie)
  const client = await connect(device.token)
  await client.hello()
  const sent = devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi', actions: [{ id: 'ok', title: 'OK' }] })
  const call = await client.next((m) => m.type === 'call')
  client.send({ type: 'result', id: call.id, ok: true, value: null })
  client.send({ type: 'event', capability: 'notifications', name: 'action', data: { id: (await sent).id, action: 'ok' } })
  await until(() => queryLogs(host, { project: 'alarms', limit: 10 }).length > 0)
  expect(queryLogs(host, { project: 'alarms', limit: 10 })[0]).toMatchObject({
    level: 'warn',
    event: 'trigger',
    message: expect.stringContaining('no trigger handles notification actions'),
  })

  // Unanswered, so the app's retry runs the trigger added since.
  triggers = { snooze: { device: { capability: 'notifications', event: 'action' } } }
  client.send({ type: 'event', capability: 'notifications', name: 'action', data: { id: (await sent).id, action: 'ok' } })
  await until(() => invoked.length === 1)
  expect(invoked[0]).toMatchObject({ name: 'snooze', payload: { action: 'ok' } })
})

test('devices of people taken off the allowlist are hidden from projects and lose their socket', async () => {
  const device = await pairDevice(app.base, cookie)
  const base = (await startSockets(100)).replace('ws:', 'http:')
  const client = await connect(device.token, base)
  await client.hello()
  expect(devices.info()).toHaveLength(1)

  allowlist.emails = []
  expect(devices.info()).toEqual([])
  expect(devices.list()).toMatchObject([{ name: 'kaan-iphone', ownerAllowed: false }])
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({ code: 'unknown_device' })
  expect((await client.closed).code).toBe(CLOSE_OWNER_NOT_ALLOWED)
})

test('the socket notices the allowlist change on its own', async () => {
  const device = await pairDevice(app.base, cookie)
  const base = (await startSockets(100)).replace('ws:', 'http:')
  const client = await connect(device.token, base)
  await client.hello()
  allowlist.emails = []
  expect((await client.closed).code).toBe(CLOSE_OWNER_NOT_ALLOWED)
})

test('closing devices ends every socket, also ones that never said hello', async () => {
  const device = await pairDevice(app.base, cookie)
  const helloed = await connect(device.token)
  await helloed.hello()
  const silent = await connect(device.token)
  devices.close()
  await helloed.closed
  await silent.closed
})

test("a failed call answers with the app's error, and a silent app times out", async () => {
  const device = await pairDevice(app.base, cookie)
  const client = await connect(device.token)
  await client.hello()

  const refused = devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' }).catch((err: unknown) => err)
  const call = await client.next((m) => m.type === 'call')
  client.send({ type: 'result', id: call.id, ok: false, error: { code: 'not_authorized', message: 'Notifications are turned off' } })
  expect(await refused).toMatchObject({ code: 'not_authorized', message: 'Notifications are turned off' })

  // No push is set up, so a timeout on the socket leaves nothing to fall back on.
  const silent = await devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' }).catch((err: unknown) => err)
  expect(silent).toMatchObject({ code: 'unreachable', message: expect.stringContaining('did not answer') })
})

test('the host answers pings and drops a connection that misses two', async () => {
  const device = await pairDevice(app.base, cookie)
  const base = await startSockets(100)
  const live = await connect(device.token, base.replace('ws:', 'http:'))
  await live.hello()
  live.send({ type: 'ping' })
  expect(await live.next((m) => m.type === 'pong')).toEqual({ type: 'pong' })
  await live.next((m) => m.type === 'ping')

  live.answerPings = false
  expect((await live.closed).code).toBe(CLOSE_TIMEOUT)
  await until(() => !devices.list()[0]!.connected)
})

test('a connection that never says hello is closed', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
  try {
    const device = await pairDevice(app.base, cookie)
    const client = await connect(device.token)
    await vi.advanceTimersByTimeAsync(30_000)
    vi.useRealTimers()
    expect(await client.closed).toEqual({ code: CLOSE_PROTOCOL_ERROR, reason: 'Send hello first' })
  } finally {
    vi.useRealTimers()
  }
})

test('messages that are not JSON objects close the connection', async () => {
  const device = await pairDevice(app.base, cookie)
  const client = await connect(device.token)
  client.ws.send('hello?')
  expect((await client.closed).code).toBe(CLOSE_PROTOCOL_ERROR)
})

test('revoking a device in the web UI closes its socket', async () => {
  const device = await pairDevice(app.base, cookie)
  const client = await connect(device.token)
  await client.hello()
  const res = await fetch(`${app.base}/api/devices/${device.deviceId}/revoke`, { method: 'POST', headers: writeHeaders(cookie) })
  expect(res.status).toBe(204)
  expect((await client.closed).code).toBe(CLOSE_REVOKED)
  const retry = new AppClient(app.base, device.token)
  await expect(retry.opened()).rejects.toThrow('401')
})

test('a second connection of the same device replaces the first', async () => {
  const device = await pairDevice(app.base, cookie)
  const first = await connect(device.token)
  await first.hello()
  const second = await connect(device.token)
  second.send({ type: 'hello', capabilities: ['notifications'] })
  expect((await first.closed).code).toBe(4000)
  expect(devices.list()[0]).toMatchObject({ connected: true })
})

function deviceRequest(path: string, method: string, token: string, body?: unknown) {
  return fetch(`${app.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('a device whose owner is off the allowlist gets 403 not_allowed, and works again once they are back', async () => {
  const device = await pairDevice(app.base, cookie)
  allowlist.emails = []

  const calls: [string, string, unknown][] = [
    ['/api/devices/web-session', 'POST', { returnTo: '/' }],
    ['/api/devices/push', 'PUT', { grant: null }],
    ['/api/devices/events', 'POST', { capability: 'notifications', name: 'action', data: {} }],
    ['/api/devices/self', 'DELETE', undefined],
  ]
  for (const [path, method, body] of calls) {
    const res = await deviceRequest(path, method, device.token, body)
    expect(res.status, path).toBe(403)
    expect(await res.json(), path).toEqual({ error: 'not_allowed' })
  }
  await expect(new AppClient(app.base, device.token).opened()).rejects.toThrow('403')
  // An unknown token is still a 401, which the app takes as removed.
  expect((await deviceRequest('/api/devices/push', 'PUT', 'hwd_wrong', { grant: null })).status).toBe(401)
  await expect(new AppClient(app.base, 'hwd_wrong').opened()).rejects.toThrow('401')
  expect(getDevice(host.db, device.deviceId)).toBeDefined()

  allowlist.emails = ['kaan@example.com']
  expect((await deviceRequest('/api/devices/push', 'PUT', device.token, { grant: null })).status).toBe(204)
  const client = await connect(device.token)
  await client.hello()
})

test('the app removes its own device when signing out', async () => {
  const device = await pairDevice(app.base, cookie)
  const push = { grant: 'R3JhbnQtZm9yLXRoZS1hcHA', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  expect((await deviceRequest('/api/devices/push', 'PUT', device.token, push)).status).toBe(204)
  const link = await deviceRequest('/api/devices/web-session', 'POST', device.token, { returnTo: '/' })
  const url = new URL(((await link.json()) as { url: string }).url)
  const open = await fetch(`${app.base}${url.pathname}${url.search}`, { redirect: 'manual' })
  const webView = `hobwork_session=${/hobwork_session=([^;]+)/.exec(open.headers.get('set-cookie') ?? '')![1]}`
  const client = await connect(device.token)
  await client.hello()

  expect((await deviceRequest('/api/devices/self', 'DELETE', device.token)).status).toBe(204)
  expect((await client.closed).code).toBe(CLOSE_REVOKED)
  expect(getDevice(host.db, device.deviceId)).toBeUndefined()
  expect(host.db.prepare('SELECT push_grant FROM devices WHERE id = ?').get(device.deviceId)).toEqual({ push_grant: null })
  const session = (await (await fetch(`${app.base}/api/session`, { headers: { cookie: webView } })).json()) as { user: unknown }
  expect(session.user).toBeNull()
  expect((await deviceRequest('/api/devices/self', 'DELETE', device.token)).status).toBe(401)
  await expect(new AppClient(app.base, device.token).opened()).rejects.toThrow('401')
  expect(devices.list()).toEqual([])
})
