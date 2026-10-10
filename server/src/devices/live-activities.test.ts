import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Caller } from '../../../packages/sdk/src/people.ts'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp } from '../test-web.ts'
import { createDevices, type Devices } from './devices.ts'
import type { Declarations, RouteAnswer } from './hob-surfaces.ts'
import { devicesResponse } from './internal.ts'
import { PUSH_INTERVAL_MS, RESTART_AFTER_MS } from './live-activities.ts'
import { createRelayPush, liveActivitySize } from './push/relay.ts'
import type { HostMessage } from './registry.ts'
import { createPairingCode, exchangePairingCode, getDevice, markDeviceActive, recordHello, type Device } from './store.ts'
import { pairDevice, pkce } from './test-devices.ts'
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
let declarations: Record<string, Declarations>
let answers: (request: { method: string; path: string; body?: unknown }) => RouteAnswer

const ENDS = '2026-10-09T14:00:00.000Z'

beforeEach(async () => {
  host = createTestHost()
  keys = testPushKeys()
  relay = await startFakeRelay(keys)
  clock = Date.parse('2026-10-09T10:00:00Z')
  routed = []
  userId = signedIn(host).user.id
  declarations = {}
  answers = () => ({ status: 200, body: {} })
  const now = () => clock
  devices = createDevices({
    host,
    relay: createRelayPush({ url: relay.url, keys, now }),
    now,
    triggers: async () => ({}),
    invokeRoute: async (project, request, caller) => {
      routed.push({ project, request, caller })
      return 200
    },
    callRoute: async (project, request, caller) => {
      routed.push({ project, request, caller })
      return answers(request)
    },
    declarations: async (project) => {
      const found = declarations[project]
      if (!found) throw new Error('never deployed')
      return found
    },
  })
  await createProject(host, 'filament')
})

afterEach(async () => {
  devices.close()
  await relay.close()
  host.dispose()
})

function pair(name: string, options: { capabilities?: string[]; activeAt?: number; startToken?: string | null } = {}): Device {
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId, name, platform: 'ios', codeChallenge: challenge })
  const { device } = exchangePairingCode(host.db, code, verifier)
  recordHello(host.db, device.id, {
    appVersion: '1.0',
    capabilities: options.capabilities ?? ['notifications', 'liveActivities', 'widgets'],
    push: relay.appPush(`grant-${name}`),
  })
  if (options.activeAt !== undefined) markDeviceActive(host.db, device.id, options.activeAt)
  const startToken = options.startToken === undefined ? `start-${name}` : options.startToken
  if (startToken) void devices.handleEvent(device.id, { capability: 'liveActivities', name: 'startToken', data: { token: startToken } })
  return getDevice(host.db, device.id)!
}

function connect(device: Device, answer: (call: Call) => unknown = (call) => (call.method === 'start' ? { activity: 'ak-1' } : { updated: true })) {
  const calls: Call[] = []
  const connection = {
    deviceId: device.id,
    send(message: HostMessage) {
      if (message.type !== 'call') return
      calls.push(message)
      queueMicrotask(() => devices.registry.result(connection, { id: message.id, ok: true, value: answer(message) }))
    },
    close() {},
  }
  devices.registry.attach(connection)
  return { calls, close: () => devices.registry.detach(connection) }
}

function pushes(name: string) {
  return relay.received.filter((r) => r.path === `/v1/grants/grant-${name}/push`)
}

function report(device: Device, data: Record<string, unknown>) {
  return devices.handleEvent(device.id, { capability: 'liveActivities', name: 'state', data })
}

const dryer = {
  id: 'dryer',
  title: 'Dryer · 65 °C',
  subtitle: '#90 Blue, #34 Space Grey',
  swatches: ['#1E5BD7', '#5B5E63'],
  endsAt: ENDS,
  startedAt: '2026-10-09T10:00:00Z',
  button: { title: '+2 h', route: '/dryer/extend' },
  open: '/dry',
  data: { run: 7 },
}

const dryerState = {
  title: 'Dryer · 65 °C',
  subtitle: '#90 Blue, #34 Space Grey',
  swatches: ['#1E5BD7', '#5B5E63'],
  endsAt: Date.parse(ENDS) / 1000,
  startedAt: Date.parse('2026-10-09T10:00:00Z') / 1000,
  button: { title: '+2 h' },
  open: '/dry',
}

test('a person gets it on every device that allows it: started by the open app, or by push', async () => {
  const phone = pair('kaan-iphone', { activeAt: clock - 1000 })
  pair('kaan-ipad', { activeAt: clock - 5000 })
  pair('kaan-mini', { activeAt: clock - 9000, startToken: null })
  pair('kaan-watch', { capabilities: ['notifications'] })
  const app = connect(phone)

  const started = await devices.liveActivities.startForPerson('filament', userId, dryer)
  expect(started).toEqual({
    id: 'dryer',
    devices: [
      { device: 'kaan-iphone', delivery: 'app' },
      { device: 'kaan-ipad', delivery: 'push' },
      { device: 'kaan-mini', error: { code: 'unreachable', message: expect.stringContaining('Opening the Hobwork app on it once') } },
    ],
  })
  expect(app.calls).toHaveLength(1)
  expect(app.calls[0]).toMatchObject({ capability: 'liveActivities', method: 'start' })
  const args = app.calls[0]!.args as { id: string }
  expect(args).toEqual({ hob: 'filament', id: expect.stringMatching(/^[0-9a-f-]{36}$/), state: dryerState })

  const [push] = pushes('kaan-ipad')
  expect(push!.body).toMatchObject({ kind: 'liveactivity', event: 'start', activity: 'start-kaan-ipad', priority: 10 })
  expect(push!.body.collapseId).toBeUndefined()
  // Only the app can read what it shows.
  expect(push!.plaintext).toEqual({ v: 1, sentAt: clock / 1000, expiresAt: 0, aps: {}, hobwork: { liveActivity: { hob: 'filament', id: args.id, state: dryerState } } })
})

test('a person or device that cannot show them is refused', async () => {
  await expect(devices.liveActivities.startForPerson('filament', 999, dryer)).rejects.toMatchObject({ code: 'unknown_person' })
  pair('kaan-mac', { capabilities: ['notifications'] })
  await expect(devices.liveActivities.startForPerson('filament', userId, dryer)).rejects.toMatchObject({ code: 'unreachable' })
  await expect(devices.liveActivities.startOnDevice('filament', 'kaan-mac', dryer)).rejects.toMatchObject({ code: 'unsupported' })
})

test.each([
  [{ ...dryer, id: 'a b' }, 'id must be'],
  [{ ...dryer, title: '' }, 'title must be'],
  [{ ...dryer, swatches: ['blue'] }, 'swatches must be'],
  [{ ...dryer, swatches: ['#000000', '#000000', '#000000', '#000000', '#000000'] }, 'swatches must be'],
  [{ ...dryer, progress: 2 }, 'progress must be'],
  [{ ...dryer, endsAt: 'tonight' }, 'endsAt must be an ISO'],
  [{ ...dryer, button: { title: '+2 h' } }, 'button needs a route'],
  [{ ...dryer, button: { title: 'A button title that is long', route: '/a' } }, 'button.title must be'],
  [{ ...dryer, pastLimit: 'never' }, 'pastLimit must be'],
  [{ ...dryer, devices: 'all' }, 'only works with ctx.person'],
  [{ ...dryer, colour: '#000000' }, 'no field colour'],
])('%j is refused', async (activity, message) => {
  pair('kaan-iphone')
  await expect(devices.liveActivities.startOnDevice('filament', 'kaan-iphone', activity)).rejects.toMatchObject({
    code: 'bad_request',
    message: expect.stringContaining(message),
  })
})

async function startedByPush(name = 'kaan-iphone') {
  const device = pair(name)
  await devices.liveActivities.startOnDevice('filament', name, dryer)
  const id = (pushes(name)[0]!.plaintext.hobwork.liveActivity as { id: string }).id
  await report(device, { id, activity: 'ak-1', state: 'active', token: `update-${name}` })
  return { device, id }
}

test('updates push changes at once and hold back small progress steps for the push budget', async () => {
  await startedByPush()
  await devices.liveActivities.update('filament', 'dryer', { subtitle: '#90 Blue' }, 'all')
  let sent = pushes('kaan-iphone')
  expect(sent).toHaveLength(2)
  expect(sent[1]!.body).toMatchObject({ kind: 'liveactivity', event: 'update', activity: 'update-kaan-iphone', priority: 10 })
  expect((sent[1]!.plaintext.hobwork.liveActivity as { state: { subtitle: string } }).state.subtitle).toBe('#90 Blue')

  clock += 60_000
  expect(await devices.liveActivities.update('filament', 'dryer', { progress: 0.5 }, 'all')).toEqual({
    updated: true,
    devices: [{ device: 'kaan-iphone', delivery: 'push' }],
  })
  expect(pushes('kaan-iphone')[2]!.body.priority).toBe(5)
  clock += 60_000
  expect((await devices.liveActivities.update('filament', 'dryer', { progress: 0.51 }, 'all')).devices).toEqual([{ device: 'kaan-iphone', delivery: 'queued' }])
  expect(pushes('kaan-iphone')).toHaveLength(3)
  clock += 60_000
  await devices.liveActivities.update('filament', 'dryer', { progress: 0.53 }, 'all')
  expect(pushes('kaan-iphone')).toHaveLength(4)

  clock += 60_000
  await devices.liveActivities.update('filament', 'dryer', { progress: 0.54 }, 'all')
  await devices.liveActivities.tick()
  expect(pushes('kaan-iphone')).toHaveLength(4)
  clock += PUSH_INTERVAL_MS
  await devices.liveActivities.tick()
  sent = pushes('kaan-iphone')
  expect(sent).toHaveLength(5)
  expect(sent[4]!.body.priority).toBe(5)
  expect((sent[4]!.plaintext.hobwork.liveActivity as { state: { progress: number } }).state.progress).toBe(0.54)
})

test('timestamps only go up, so an end right after an update is not dropped', async () => {
  await startedByPush()
  await devices.liveActivities.update('filament', 'dryer', { subtitle: 'x' }, 'all')
  await devices.liveActivities.end('filament', 'dryer', {}, 'all')
  const [, update, end] = pushes('kaan-iphone')
  expect(end!.body.timestamp as number).toBeGreaterThan(update!.body.timestamp as number)
})

test('a device whose app has not reported its token yet gets the latest content once it does', async () => {
  const device = pair('kaan-iphone')
  await devices.liveActivities.startOnDevice('filament', 'kaan-iphone', dryer)
  const id = (pushes('kaan-iphone')[0]!.plaintext.hobwork.liveActivity as { id: string }).id
  expect((await devices.liveActivities.update('filament', 'dryer', { subtitle: 'later' }, 'all')).devices).toEqual([
    { device: 'kaan-iphone', delivery: 'queued' },
  ])
  await report(device, { id, activity: 'ak-1', state: 'active', token: 'update-1' })
  const sent = pushes('kaan-iphone')
  expect(sent).toHaveLength(2)
  expect(sent[1]!.body).toMatchObject({ event: 'update', activity: 'update-1' })
})

test('ending pushes the end with a dismissal date, and the activity is gone after', async () => {
  await startedByPush()
  const ended = await devices.liveActivities.end('filament', 'dryer', { content: { subtitle: 'Took them out' }, dismissAt: 'now' }, 'all')
  expect(ended).toEqual({ ended: true, devices: [{ device: 'kaan-iphone', delivery: 'push' }] })
  const end = pushes('kaan-iphone')[1]!
  expect(end.body).toMatchObject({ event: 'end', activity: 'update-kaan-iphone', dismissalDate: clock / 1000, priority: 10 })
  expect(await devices.liveActivities.update('filament', 'dryer', { subtitle: 'x' }, 'all')).toEqual({ updated: false, devices: [] })
  expect(await devices.liveActivities.end('filament', 'dryer', {}, 'all')).toEqual({ ended: false, devices: [] })
  await expect(devices.liveActivities.end('filament', 'dryer', { dismissAt: '2026-10-10T10:00:00Z' }, 'all')).resolves.toEqual({ ended: false, devices: [] })
})

test('a device where the person dismissed it does not get it again until it ends', async () => {
  const { device, id } = await startedByPush()
  await report(device, { id, activity: 'ak-1', state: 'dismissed' })
  expect((await devices.liveActivities.update('filament', 'dryer', { subtitle: 'x' }, 'all')).updated).toBe(false)
  const again = await devices.liveActivities.startOnDevice('filament', 'kaan-iphone', dryer)
  expect(again.devices).toEqual([{ device: 'kaan-iphone', error: { code: 'dismissed', message: expect.any(String) } }])

  await devices.liveActivities.end('filament', 'dryer', {}, 'all')
  await devices.liveActivities.startOnDevice('filament', 'kaan-iphone', dryer)
  expect(pushes('kaan-iphone').at(-1)!.body.event).toBe('start')
})

test('reports about an activity the device replaced are ignored', async () => {
  const { device, id } = await startedByPush()
  clock += RESTART_AFTER_MS
  await devices.liveActivities.tick()
  await report(device, { id, activity: 'ak-1', state: 'ended' })
  await report(device, { id, activity: 'ak-2', state: 'active', token: 'update-2' })
  await devices.liveActivities.update('filament', 'dryer', { subtitle: 'x' }, 'all')
  expect(pushes('kaan-iphone').at(-1)!.body).toMatchObject({ event: 'update', activity: 'update-2' })
})

test('before the 8 hour limit it restarts with push-to-start', async () => {
  await startedByPush()
  clock += RESTART_AFTER_MS - 60_000
  await devices.liveActivities.tick()
  expect(pushes('kaan-iphone')).toHaveLength(1)
  clock += 60_000
  await devices.liveActivities.tick()
  const [, end, start] = pushes('kaan-iphone')
  expect(end!.body).toMatchObject({ event: 'end', activity: 'update-kaan-iphone', dismissalDate: clock / 1000 })
  expect(start!.body).toMatchObject({ event: 'start', activity: 'start-kaan-iphone' })
  expect((start!.plaintext.hobwork.liveActivity as { state: unknown }).state).toEqual(dryerState)
})

test('without push-to-start, or with stillRunning, it switches to "Still running" instead', async () => {
  const { device } = await startedByPush()
  await devices.handleEvent(device.id, { capability: 'liveActivities', name: 'startToken', data: { token: null } })
  clock += RESTART_AFTER_MS
  await devices.liveActivities.tick()
  const last = pushes('kaan-iphone').at(-1)!
  expect(last.body).toMatchObject({ event: 'update', priority: 10 })
  expect((last.plaintext.hobwork.liveActivity as { state: unknown }).state).toEqual({ ...dryerState, stillRunning: true })
  await devices.liveActivities.tick()
  expect(pushes('kaan-iphone')).toHaveLength(2)

  pair('kaan-ipad')
  await devices.liveActivities.startOnDevice('filament', 'kaan-ipad', { ...dryer, id: 'oven', pastLimit: 'stillRunning' })
  const ipad = pushes('kaan-ipad')
  const id = (ipad[0]!.plaintext.hobwork.liveActivity as { id: string }).id
  await report(getDevice(host.db, 2)!, { id, activity: 'ak-9', state: 'active', token: 'u-ipad' })
  clock += RESTART_AFTER_MS
  await devices.liveActivities.tick()
  expect(pushes('kaan-ipad').at(-1)!.body).toMatchObject({ event: 'update', activity: 'u-ipad' })
})

test('a token the relay says is gone is forgotten', async () => {
  await startedByPush()
  relay.answer(() => ({ status: 410, body: { error: 'activity_gone', message: 'The token is gone' } }))
  const updated = await devices.liveActivities.update('filament', 'dryer', { subtitle: 'x' }, 'all')
  expect(updated.devices).toEqual([{ device: 'kaan-iphone', error: { code: 'push_failed', message: expect.stringContaining('activity_gone') } }])
  relay.answer(() => ({ status: 200 }))
  expect((await devices.liveActivities.update('filament', 'dryer', { subtitle: 'y' }, 'all')).devices).toEqual([{ device: 'kaan-iphone', delivery: 'queued' }])
})

test('the button runs its route as the person who tapped it', async () => {
  const { device, id } = await startedByPush()
  await devices.handleEvent(device.id, { capability: 'liveActivities', name: 'action', data: { id } })
  expect(routed).toEqual([
    {
      project: 'filament',
      request: { method: 'POST', path: '/dryer/extend', body: { activityId: 'dryer', data: { run: 7 } } },
      caller: { person: expect.objectContaining({ id: userId }), device: { name: 'kaan-iphone', platform: 'ios' } },
    },
  ])
})

test('the open app gets updates and ends over its socket', async () => {
  const phone = pair('kaan-iphone')
  const app = connect(phone)
  await devices.liveActivities.startOnDevice('filament', 'kaan-iphone', dryer)
  const update = await devices.liveActivities.update('filament', 'dryer', { progress: 0.1 }, { device: phone.id })
  expect(update.devices).toEqual([{ device: 'kaan-iphone', delivery: 'app' }])
  await devices.liveActivities.end('filament', 'dryer', { dismissAt: 'now' }, 'all')
  expect(app.calls.map((c) => c.method)).toEqual(['start', 'update', 'end'])
  expect(app.calls[2]!.args).toMatchObject({ dismissAt: clock / 1000 })
  expect(pushes('kaan-iphone')).toHaveLength(0)
})

test('update and end for a person only change their devices', async () => {
  await startedByPush()
  expect(await devices.liveActivities.update('filament', 'dryer', { subtitle: 'x' }, { person: userId + 1 })).toEqual({ updated: false, devices: [] })
  expect((await devices.liveActivities.update('filament', 'dryer', { subtitle: 'x' }, { person: userId })).updated).toBe(true)
})

test('the web bridge starts it on this device, which starts it itself', async () => {
  const phone = pair('kaan-iphone')
  const started = devices.liveActivities.startHere('filament', phone, { ...dryer, relevance: 50 })
  expect(started).toEqual({ id: 'dryer', activity: { hob: 'filament', id: expect.any(String), state: dryerState, relevance: 50 } })
  await report(phone, { id: started.activity.id, activity: 'ak-1', state: 'active', token: 'u-1' })
  await devices.liveActivities.update('filament', 'dryer', { subtitle: 'x' }, 'all')
  expect(pushes('kaan-iphone')[0]!.body).toMatchObject({ event: 'update', activity: 'u-1', relevanceScore: 50 })
})

test('handlers reach Live Activities through the internal endpoint', async () => {
  pair('kaan-iphone')
  const call = async (request: unknown) => (await devicesResponse(JSON.stringify(request), { devices, project: 'filament', access: 'full' })).json()
  expect(await call({ action: 'liveActivity', op: 'start', person: userId, args: dryer })).toEqual({
    ok: true,
    result: { id: 'dryer', devices: [{ device: 'kaan-iphone', delivery: 'push' }] },
  })
  expect(await call({ action: 'liveActivity', op: 'update', device: 'kaan-iphone', id: 'dryer', args: { subtitle: 'x' } })).toEqual({
    ok: true,
    result: { updated: true, devices: [{ device: 'kaan-iphone', delivery: 'queued' }] },
  })
  expect(await call({ action: 'liveActivity', op: 'start', args: dryer })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  const readOnly = await devicesResponse(JSON.stringify({ action: 'liveActivity', op: 'end', id: 'dryer' }), { devices, project: 'filament', access: 'read' })
  expect(readOnly.status).toBe(403)
})

test('the size check matches the payload the relay builds', async () => {
  pair('kaan-iphone')
  await devices.liveActivities.startOnDevice('filament', 'kaan-iphone', { ...dryer, relevance: 50, staleAt: ENDS })
  const { body } = pushes('kaan-iphone')[0]!
  const envelope = { hobwork: { v: 1, grant: 'grant-kaan-iphone', keyId: body.keyId, ciphertext: body.ciphertext } }
  // relay/src/payload.rs, live_activity()
  const built = {
    aps: {
      timestamp: body.timestamp,
      event: 'start',
      'content-state': envelope,
      'stale-date': body.staleDate,
      'relevance-score': body.relevanceScore,
      'attributes-type': 'HobworkActivityAttributes',
      attributes: envelope,
      alert: { title: 'Hobwork', body: 'A hob started a Live Activity.' },
      'input-push-token': 1,
    },
  }
  const id = (pushes('kaan-iphone')[0]!.plaintext.hobwork.liveActivity as { id: string }).id
  const size = liveActivitySize(
    {
      activity: String(body.activity),
      event: 'start',
      priority: 10,
      timestamp: Number(body.timestamp),
      staleDate: Number(body.staleDate),
      relevanceScore: 50,
      expiresAt: 0,
      payload: { hob: 'filament', id, state: dryerState },
    },
    clock,
    'grant-kaan-iphone',
    String(body.keyId),
  )
  expect(size).toBe(Buffer.byteLength(JSON.stringify(built)))
})

// Widgets and intents

test('widgets: the hob list, the content from the route, and reloads', async () => {
  const phone = pair('kaan-iphone')
  declarations.filament = {
    widget: '/widget',
    intents: [
      { id: 'scan', title: 'Open Scan', method: 'POST', parameters: [], opensApp: false, open: '/scan' },
      { id: 'where', title: 'Where is a spool', route: '/where', method: 'POST', parameters: [{ id: 'spool', title: 'Spool', type: 'number', optional: false }], opensApp: false },
    ],
  }
  expect(await devices.surfaces.hobs()).toEqual([
    {
      hob: 'filament',
      widget: true,
      intents: [
        { id: 'scan', title: 'Open Scan', parameters: [], opensApp: false, open: '/scan', runs: false },
        { id: 'where', title: 'Where is a spool', parameters: [{ id: 'spool', title: 'Spool', type: 'number', optional: false }], opensApp: false, runs: true },
      ],
    },
  ])

  answers = () => ({
    status: 200,
    body: {
      title: 'Now',
      lines: [{ text: 'Dryer', detail: 'ends 19:10', swatches: ['#1E5BD7', 'blue'] }, { nope: 1 }],
      swatches: ['#000000'],
      open: '/now',
      refreshAt: '2026-10-09T10:01:00Z',
    },
  })
  expect(await devices.surfaces.widget(phone, 'filament')).toEqual({
    title: 'Now',
    lines: [{ text: 'Dryer', detail: 'ends 19:10', swatches: ['#1E5BD7'] }],
    swatches: ['#000000'],
    open: '/now',
    refreshAt: '2026-10-09T10:05:00.000Z',
  })
  expect(routed[0]).toMatchObject({ request: { method: 'GET', path: '/widget' }, caller: { device: { name: 'kaan-iphone' } } })
  answers = () => ({ status: 500, body: {} })
  await expect(devices.surfaces.widget(phone, 'filament')).rejects.toMatchObject({ status: 502 })
  await expect(devices.surfaces.widget(phone, 'nothing')).rejects.toMatchObject({ status: 404 })

  const reloaded = await devices.reloadWidgets({ person: userId })
  expect(reloaded).toEqual({ devices: [{ device: 'kaan-iphone', delivery: 'push' }] })
  const [push] = pushes('kaan-iphone')
  expect(push!.body).toMatchObject({ kind: 'background' })
  expect(push!.plaintext.hobwork).toEqual({ reloadWidgets: true })
  const app = connect(phone, () => ({}))
  expect(await devices.reloadWidgets({ device: 'kaan-iphone' })).toEqual({ devices: [{ device: 'kaan-iphone', delivery: 'app' }] })
  expect(app.calls[0]).toMatchObject({ capability: 'widgets', method: 'reload' })
})

test('intents run their route with the parameters and say what the route answers', async () => {
  const phone = pair('kaan-iphone')
  declarations.filament = {
    intents: [
      { id: 'where', title: 'Where is a spool', route: '/where', method: 'POST', parameters: [{ id: 'spool', title: 'Spool', type: 'number', optional: false }], opensApp: false },
      { id: 'dry', title: 'Start the dryer', route: '/dry/start', method: 'POST', parameters: [], opensApp: true, open: '/dry' },
      { id: 'scan', title: 'Open Scan', method: 'POST', parameters: [], opensApp: false, open: '/scan' },
    ],
  }
  answers = (request) => ({ status: 200, body: request.path === '/where' ? { say: 'Spool 78 is in Bin 4.' } : {} })
  expect(await devices.surfaces.runIntent(phone, { hob: 'filament', intent: 'where', parameters: { spool: 78 } })).toEqual({ say: 'Spool 78 is in Bin 4.' })
  expect(routed[0]).toMatchObject({ request: { method: 'POST', path: '/where', body: { intent: 'where', parameters: { spool: 78 } } } })
  expect(await devices.surfaces.runIntent(phone, { hob: 'filament', intent: 'dry' })).toEqual({ open: '/dry' })
  expect(await devices.surfaces.runIntent(phone, { hob: 'filament', intent: 'scan' })).toEqual({ open: '/scan' })
  expect(routed).toHaveLength(2)
  await expect(devices.surfaces.runIntent(phone, { hob: 'filament', intent: 'where', parameters: { spool: '78' } })).rejects.toMatchObject({ status: 400 })
  await expect(devices.surfaces.runIntent(phone, { hob: 'filament', intent: 'where' })).rejects.toMatchObject({ message: 'Spool is required' })
  await expect(devices.surfaces.runIntent(phone, { hob: 'filament', intent: 'nope' })).rejects.toMatchObject({ status: 404 })
})

test('the app reaches Live Activities, widgets and intents over HTTP with its device token', async () => {
  const app = await startTestApp(host, { devices })
  try {
    const { token, deviceId } = await pairDevice(app.base, signedIn(host).cookie)
    const post = (path: string, body: unknown) =>
      fetch(`${app.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const get = (path: string) => fetch(`${app.base}${path}`, { headers: { authorization: `Bearer ${token}` } })

    let res = await post('/api/devices/live-activities', { hob: 'filament', op: 'start', args: dryer })
    expect(res.status).toBe(403)
    recordHello(host.db, deviceId, { appVersion: '1.0', capabilities: ['liveActivities', 'widgets'] })
    res = await post('/api/devices/live-activities', { hob: 'filament', op: 'start', args: dryer })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'dryer', activity: { hob: 'filament', state: dryerState } })
    res = await post('/api/devices/live-activities', { hob: 'filament', op: 'update', id: 'dryer', args: { subtitle: 'x' } })
    expect(await res.json()).toEqual({ updated: true, devices: [{ device: 'kaan-iphone', delivery: 'queued' }] })
    res = await post('/api/devices/live-activities', { hob: 'filament', op: 'start', args: { id: 'x' } })
    expect(res.status).toBe(400)

    declarations.filament = { widget: '/widget', intents: [{ id: 'scan', title: 'Open Scan', method: 'POST', parameters: [], opensApp: false, open: '/scan' }] }
    answers = () => ({ status: 200, body: { title: 'Now' } })
    expect(await (await get('/api/devices/hobs')).json()).toMatchObject({ hobs: [{ hob: 'filament', widget: true }] })
    expect(await (await get('/api/devices/widgets/filament')).json()).toMatchObject({ title: 'Now' })
    expect((await get('/api/devices/widgets/other')).status).toBe(404)
    expect(await (await post('/api/devices/intents', { hob: 'filament', intent: 'scan' })).json()).toEqual({ ok: true, open: '/scan' })
    expect(await (await post('/api/devices/intents', { hob: 'filament', intent: 'nope' })).json()).toMatchObject({ ok: false, error: { code: 'unknown_intent' } })
    expect((await fetch(`${app.base}/api/devices/hobs`)).status).toBe(401)
  } finally {
    await app.close()
  }
})
