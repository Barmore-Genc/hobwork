import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Caller } from '../../../packages/sdk/src/people.ts'
import { createProject } from '../projects.ts'
import { queryLogs } from '../runtime/logs.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn } from '../test-web.ts'
import { createDevices, type Devices } from './devices.ts'
import { devicesResponse } from './internal.ts'
import { createRelayPush } from './push/relay.ts'
import type { HostMessage } from './registry.ts'
import { createPairingCode, exchangePairingCode, markDeviceActive, recordHello, type Device } from './store.ts'
import { pkce } from './test-devices.ts'
import { startFakeRelay, testPushKeys } from './test-relay.ts'

type Call = Extract<HostMessage, { type: 'call' }>
type Routed = { project: string; request: { method: string; path: string; body?: unknown }; caller: Caller }

let host: ReturnType<typeof createTestHost>
let relay: Awaited<ReturnType<typeof startFakeRelay>>
let keys: ReturnType<typeof testPushKeys>
let devices: Devices
let clock: number
let routed: Routed[]
let userId: number

function create() {
  const now = () => clock
  return createDevices({
    host,
    relay: createRelayPush({ url: relay.url, keys, now }),
    now,
    withdrawWaitMs: 200,
    triggers: async () => ({}),
    invokeRoute: async (project, request, caller) => {
      routed.push({ project, request, caller })
      return 200
    },
  })
}

beforeEach(async () => {
  host = createTestHost()
  keys = testPushKeys()
  relay = await startFakeRelay(keys)
  clock = Date.parse('2026-10-09T10:00:00Z')
  routed = []
  userId = signedIn(host).user.id
  devices = create()
  await createProject(host, 'filament')
})

afterEach(async () => {
  devices.close()
  await relay.close()
  host.dispose()
})

function pair(name: string, options: { user?: number; capabilities?: string[]; activeAt?: number } = {}): Device {
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId: options.user ?? userId, name, platform: 'ios', codeChallenge: challenge })
  const { device } = exchangePairingCode(host.db, code, verifier)
  recordHello(host.db, device.id, { appVersion: '1.0', capabilities: options.capabilities ?? ['notifications'], push: relay.appPush(`grant-${name}`) })
  if (options.activeAt !== undefined) markDeviceActive(host.db, device.id, options.activeAt)
  return device
}

// An app on its socket that answers every call with answer(call).
function connect(device: Device, answer: (call: Call) => { ok: true; value?: unknown } | { ok: false; error: unknown } = () => ({ ok: true, value: null })) {
  const calls: Call[] = []
  const connection = {
    deviceId: device.id,
    send(message: HostMessage) {
      if (message.type !== 'call') return
      calls.push(message)
      queueMicrotask(() => devices.registry.result(connection, { id: message.id, ...answer(message) }))
    },
    close() {},
  }
  devices.registry.attach(connection)
  return calls
}

function pushes(grant: string) {
  return relay.received.filter((r) => r.path === `/v1/grants/grant-${grant}/push`)
}

test('a person gets the notification on every device: over the socket or by push', async () => {
  const phone = pair('kaan-iphone', { activeAt: clock - 1000 })
  pair('kaan-mac', { activeAt: clock - 5000 })
  const calls = connect(phone)

  const sent = await devices.notifyPerson('filament', userId, {
    id: 'print:42',
    title: 'Gojira stopped',
    body: 'Tray 3 would not feed.',
    interruptionLevel: 'timeSensitive',
    thread: 'printer',
    open: '/print/problem',
    actions: [
      { id: 'claim', title: "I'm on it", route: '/jobs/42/claim' },
      { id: 'ranOut', title: 'Spool ran out', route: '/trays/3/empty', open: '/tray/3', destructive: true },
      { id: 'open', title: 'Open', foreground: true },
    ],
    data: { job: 42 },
  })
  expect(sent).toEqual({
    id: 'print:42',
    scheduled: false,
    devices: [
      { device: 'kaan-iphone', delivery: 'app' },
      { device: 'kaan-mac', delivery: 'push' },
    ],
  })

  const actions = [
    { id: 'claim', title: "I'm on it" },
    { id: 'ranOut', title: 'Spool ran out', foreground: true, destructive: true, open: '/tray/3' },
    { id: 'open', title: 'Open', foreground: true },
  ]
  expect(calls).toHaveLength(1)
  const shown = calls[0]!.args as { id: string }
  expect(calls[0]).toMatchObject({ capability: 'notifications', method: 'send' })
  expect(shown).toEqual({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    project: 'filament',
    title: 'Gojira stopped',
    body: 'Tray 3 would not feed.',
    actions,
    interruptionLevel: 'timeSensitive',
    thread: 'filament/printer',
    open: '/print/problem',
  })
  const [push] = pushes('kaan-mac')
  // Both devices show it under the same ID, so updates and withdrawals reach both.
  expect(push!.body.collapseId).toBe(shown.id)
  expect(push!.plaintext.aps).toEqual({
    alert: { title: 'Gojira stopped', body: 'Tray 3 would not feed.' },
    sound: 'default',
    'interruption-level': 'time-sensitive',
    'thread-id': 'filament/printer',
    category: `hobwork.${shown.id}`,
    'mutable-content': 1,
  })
  expect(push!.plaintext.hobwork).toEqual({ id: shown.id, project: 'filament', actions, open: '/print/problem' })
})

test('lastActive sends to the device the person used last; silent and passive ones make no sound', async () => {
  pair('kaan-iphone', { activeAt: clock - 1000 })
  pair('kaan-mac', { activeAt: clock - 5000 })
  const sent = await devices.notifyPerson('filament', userId, { title: 'Dryer is running', devices: 'lastActive', sound: 'none' })
  expect(sent.devices).toEqual([{ device: 'kaan-iphone', delivery: 'push' }])
  expect(pushes('kaan-iphone')[0]!.plaintext.aps).toEqual({ alert: { title: 'Dryer is running' }, 'thread-id': 'filament' })

  await devices.notifyPerson('filament', userId, { title: 'This week', interruptionLevel: 'passive', sound: 'default' })
  expect(pushes('kaan-mac')[0]!.plaintext.aps).toEqual({ alert: { title: 'This week' }, 'interruption-level': 'passive', 'thread-id': 'filament' })
})

test('sending to a person needs a known person with a device that shows notifications', async () => {
  await expect(devices.notifyPerson('filament', 999, { title: 'Hi' })).rejects.toMatchObject({ code: 'unknown_person' })
  pair('kaan-iphone', { capabilities: ['alarms'] })
  await expect(devices.notifyPerson('filament', userId, { title: 'Hi' })).rejects.toMatchObject({ code: 'unreachable' })
  await expect(devices.sendNotification('filament', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({ code: 'unsupported' })
})

test('a device that fails is reported and the others still get it', async () => {
  pair('kaan-iphone')
  pair('kaan-mac')
  relay.answer((r) => (r.path.includes('kaan-mac') ? { status: 502, body: { error: 'apns', message: 'APNs is down' } } : { status: 200 }))
  const sent = await devices.notifyPerson('filament', userId, { title: 'Hi' })
  expect(sent.devices).toEqual([
    { device: 'kaan-iphone', delivery: 'push' },
    { device: 'kaan-mac', error: { code: 'push_failed', message: expect.stringContaining('APNs is down') } },
  ])
})

test.each([
  [{ title: 'Hi', id: 'has space' }, 'id must be'],
  [{ title: 'Hi', interruptionLevel: 'critical' }, 'interruptionLevel must be'],
  [{ title: 'Hi', sound: 'chime' }, 'sound must be'],
  [{ title: 'Hi', thread: '' }, 'thread must be'],
  [{ title: 'Hi', open: 'tray/3' }, 'open must be a path'],
  [{ title: 'Hi', deliverAt: 'tomorrow' }, 'deliverAt must be an ISO'],
  [{ title: 'Hi', deliverAt: '2026-12-01T00:00:00Z' }, 'within the next 30 days'],
  [{ title: 'Hi', devices: 'lastActive' }, 'only works with ctx.person'],
  [{ title: 'Hi', actions: [{ id: 'a', title: 'A', body: {} }] }, 'needs a route'],
  [{ title: 'Hi', actions: [{ id: 'a', title: 'A', route: '/x', method: 'GET', body: {} }] }, 'GET route takes no body'],
  [{ title: 'Hi', actions: [{ id: 'a', title: 'A', route: 'x' }] }, "action's route must be a path"],
])('%j is refused', async (notification, message) => {
  pair('kaan-iphone')
  await expect(devices.sendNotification('filament', 'kaan-iphone', notification)).rejects.toMatchObject({
    code: 'bad_request',
    message: expect.stringContaining(message),
  })
})

test('an update changes the text in place, quietly, where it still shows', async () => {
  const phone = pair('kaan-iphone')
  pair('kaan-mac')
  const calls = connect(phone)
  await devices.notifyPerson('filament', userId, { id: 'print:42', title: 'Gojira stopped', body: 'Tray 3 would not feed.', thread: 'printer' })
  const id = (calls[0]!.args as { id: string }).id

  const updated = await devices.updateNotification('filament', 'print:42', { body: 'Nozzle clog detected.' })
  expect(updated).toEqual({
    updated: true,
    devices: [
      { device: 'kaan-iphone', delivery: 'app' },
      { device: 'kaan-mac', delivery: 'push' },
    ],
  })
  expect(calls[1]!.args).toEqual({
    id,
    project: 'filament',
    title: 'Gojira stopped',
    body: 'Nozzle clog detected.',
    actions: [],
    interruptionLevel: 'passive',
    sound: 'none',
    thread: 'filament/printer',
    revision: 2,
    update: true,
  })
  const push = pushes('kaan-mac')[1]!
  expect(push.body.collapseId).toBe(id)
  expect(push.plaintext.aps).toEqual({ alert: { title: 'Gojira stopped', body: 'Nozzle clog detected.' }, 'interruption-level': 'passive', 'thread-id': 'filament/printer' })
  expect(push.plaintext.hobwork).toEqual({ id, project: 'filament', actions: [], revision: 2, update: true })

  await expect(devices.updateNotification('filament', 'print:42', { interruptionLevel: 'active' })).rejects.toMatchObject({ code: 'bad_request' })
  expect(await devices.updateNotification('filament', 'nope', { body: 'x' })).toEqual({ updated: false, devices: [] })
})

test('an action runs its route as the person and device that tapped, once', async () => {
  const phone = pair('kaan-iphone')
  connect(phone)
  await devices.sendNotification('filament', 'kaan-iphone', {
    id: 'print:42',
    title: 'Gojira stopped',
    data: { job: 42 },
    actions: [
      { id: 'claim', title: "I'm on it", route: '/jobs/42/claim' },
      { id: 'fail', title: 'Mark failed', route: '/prints/42', method: 'PATCH', body: { status: 'failed' } },
    ],
  })
  const row = host.db.prepare('SELECT id FROM notifications WHERE key = ?').get('print:42')!
  const tap = (action: string) => devices.handleEvent(phone.id, { capability: 'notifications', name: 'action', data: { id: row.id, action } })

  await tap('claim')
  await tap('claim')
  await tap('fail')
  await tap('unknown')
  await new Promise((r) => setTimeout(r, 20))
  expect(routed).toEqual([
    {
      project: 'filament',
      request: { method: 'POST', path: '/jobs/42/claim', body: { notificationId: 'print:42', action: 'claim', data: { job: 42 } } },
      caller: { person: expect.objectContaining({ id: userId, name: 'Kaan' }), device: { name: 'kaan-iphone', platform: 'ios' } },
    },
  ])

  // iOS removes a notification whose action was tapped, so an update leaves that device alone.
  expect(await devices.updateNotification('filament', 'print:42', { body: 'Still stopped' })).toEqual({ updated: true, devices: [] })
})

test('another device cannot tap a notification it never got', async () => {
  pair('kaan-iphone')
  const mac = pair('kaan-mac')
  await devices.sendNotification('filament', 'kaan-iphone', { title: 'Hi', actions: [{ id: 'ok', title: 'OK', route: '/ok' }] })
  const row = host.db.prepare('SELECT id FROM notifications').get()!
  await devices.handleEvent(mac.id, { capability: 'notifications', name: 'action', data: { id: row.id, action: 'ok' } })
  expect(routed).toEqual([])
})

test('withdrawing removes it from every device: over the socket, or with a background push', async () => {
  const phone = pair('kaan-iphone')
  pair('kaan-mac')
  const calls = connect(phone)
  await devices.notifyPerson('filament', userId, { id: 'print:42', title: 'Gojira stopped' })
  const id = (calls[0]!.args as { id: string }).id

  expect(await devices.withdrawNotification('filament', 'print:42')).toEqual({ withdrawn: true })
  expect(calls[1]).toMatchObject({ capability: 'notifications', method: 'withdraw', args: { ids: [id] } })
  const push = pushes('kaan-mac')[1]!
  expect(push.body).toMatchObject({ kind: 'background' })
  expect(push.plaintext).toMatchObject({ aps: { 'content-available': 1 }, hobwork: { withdraw: [id] } })

  expect(await devices.withdrawNotification('filament', 'print:42')).toEqual({ withdrawn: false })
  expect(calls).toHaveLength(2)
  expect(pushes('kaan-mac')).toHaveLength(2)
})

test('an app that missed a withdrawal gets it after its next hello, until it confirms', async () => {
  const phone = pair('kaan-iphone')
  await devices.sendNotification('filament', 'kaan-iphone', { id: 'n', title: 'Hi' })
  relay.answer(() => ({ status: 502, body: { error: 'apns', message: 'APNs is down' } }))
  await devices.withdrawNotification('filament', 'n')
  const row = host.db.prepare('SELECT id FROM notifications').get()!

  let fail = true
  const calls = connect(phone, () => (fail ? { ok: false, error: { code: 'timeout', message: 'slow' } } : { ok: true, value: null }))
  devices.resendPending(phone.id)
  await new Promise((r) => setTimeout(r, 20))
  expect(calls.map((c) => c.args)).toEqual([{ ids: [row.id] }])
  fail = false
  devices.resendPending(phone.id)
  await new Promise((r) => setTimeout(r, 20))
  devices.resendPending(phone.id)
  await new Promise((r) => setTimeout(r, 20))
  expect(calls.map((c) => c.args)).toEqual([{ ids: [row.id] }, { ids: [row.id] }])
})

test('sending again with the same ID replaces it, and devices left out lose it', async () => {
  const phone = pair('kaan-iphone')
  const mac = pair('kaan-mac')
  const phoneCalls = connect(phone)
  const macCalls = connect(mac)
  await devices.notifyPerson('filament', userId, { id: 'n10:7', title: 'Fire Red is under 250 g' })
  const id = (phoneCalls[0]!.args as { id: string }).id
  const sent = await devices.sendNotification('filament', 'kaan-iphone', { id: 'n10:7', title: 'Fire Red is under 200 g' })
  expect(sent).toEqual({ id: 'n10:7', delivery: 'app' })
  expect(phoneCalls[1]!.args).toMatchObject({ id, title: 'Fire Red is under 200 g', revision: 2 })
  expect(macCalls[1]).toMatchObject({ method: 'withdraw', args: { ids: [id] } })
})

test('deliverAt holds the notification until then, across restarts, and withdrawing cancels it', async () => {
  pair('kaan-iphone')
  const at = new Date(clock + 60 * 60 * 1000).toISOString()
  expect(await devices.notifyPerson('filament', userId, { id: 'dry', title: 'Dryer is running', deliverAt: at })).toEqual({
    id: 'dry',
    scheduled: true,
    devices: [],
  })
  expect(await devices.sendNotification('filament', 'kaan-iphone', { id: 'later', title: 'Later', deliverAt: at })).toEqual({
    id: 'later',
    delivery: 'scheduled',
  })
  expect(await devices.updateNotification('filament', 'dry', { body: "What's in it?" })).toEqual({ updated: true, devices: [] })
  await devices.deliverDue()
  expect(relay.received).toHaveLength(0)

  devices.close()
  devices = create()
  clock += 60 * 60 * 1000
  expect(await devices.withdrawNotification('filament', 'later')).toEqual({ withdrawn: true })
  await devices.deliverDue()
  await devices.deliverDue()
  expect(relay.received).toHaveLength(1)
  expect(relay.received[0]!.plaintext.aps.alert).toEqual({ title: 'Dryer is running', body: "What's in it?" })

  // A time that has passed sends right away.
  const now = await devices.sendNotification('filament', 'kaan-iphone', { title: 'Now', deliverAt: new Date(clock - 1000).toISOString() })
  expect(now.delivery).toBe('push')
})

test('a scheduled notification whose device is gone is logged', async () => {
  const phone = pair('kaan-iphone')
  await devices.sendNotification('filament', 'kaan-iphone', { title: 'Later', deliverAt: new Date(clock + 1000).toISOString() })
  devices.revoke(phone.id)
  clock += 2000
  await devices.deliverDue()
  expect(queryLogs(host, { project: 'filament', limit: 10 }).map((l) => l.message)).toEqual([expect.stringContaining('was not sent: The device was removed')])
})

test('workspaces cannot notify, update or withdraw', async () => {
  for (const request of [
    { action: 'notify', person: userId, args: { title: 'Hi' } },
    { action: 'updateNotification', id: 'n', args: { body: 'x' } },
    { action: 'withdrawNotification', id: 'n' },
  ]) {
    const res = await devicesResponse(JSON.stringify(request), { devices, project: 'filament', access: 'read' })
    expect(res.status).toBe(403)
  }
  pair('kaan-iphone')
  const res = await devicesResponse(JSON.stringify({ action: 'notify', person: userId, args: { title: 'Hi' } }), {
    devices,
    project: 'filament',
    access: 'full',
  })
  expect(await res.json()).toMatchObject({ ok: true, result: { scheduled: false, devices: [{ device: 'kaan-iphone', delivery: 'push' }] } })
})
