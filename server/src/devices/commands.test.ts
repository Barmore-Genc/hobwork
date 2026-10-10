import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { DeviceEvent } from '../../../packages/sdk/src/devices.ts'
import { validateHobworkJson } from '../pipeline/validate.ts'
import { createProject } from '../projects.ts'
import { queryLogs } from '../runtime/logs.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, TEST_PUBLIC_URL } from '../test-web.ts'
import { COMMANDS } from './commands.ts'
import { createDevices, type DeviceTrigger, type Devices } from './devices.ts'
import { DeviceError } from './registry.ts'
import { COMMAND_TTL_MS, getCommand, recordHello, type Push } from './store.ts'
import { createRelayPush } from './push/relay.ts'
import { pairDevice } from './test-devices.ts'
import { startFakeRelay, testPushKeys } from './test-relay.ts'

vi.setConfig({ testTimeout: 15_000 })

type Message = Record<string, unknown>
type Triggers = Record<string, { device?: DeviceTrigger }>

const ALL = ['notifications', 'alarms', 'screenTime', 'focus', 'nfc', 'health']

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string
let relay: Awaited<ReturnType<typeof startFakeRelay>>
let received: Awaited<ReturnType<typeof startFakeRelay>>['received']
let devices: Devices
let offset: number
let triggers: Record<string, Triggers>
let invoked: { project: string; name: string; payload: DeviceEvent }[]

beforeEach(async () => {
  host = createTestHost()
  cookie = signedIn(host).cookie
  offset = 0
  invoked = []
  triggers = {}
  const keys = testPushKeys()
  relay = await startFakeRelay(keys)
  received = relay.received
  const now = () => Date.now() + offset
  devices = createDevices({
    host,
    relay: createRelayPush({ url: relay.url, keys, now }),
    publicUrl: TEST_PUBLIC_URL,
    waitMs: { background: 400, foreground: 800 },
    socketFallbackMs: 150,
    now,
    triggers: async (project) => {
      if (!triggers[project]) throw new Error(`${project} has no deployed version`)
      return triggers[project]
    },
    invokeTrigger: async (project, name, payload) => invoked.push({ project, name, payload }),
  })
  app = await startTestApp(host, { devices })
  await createProject(host, 'bedtime')
})

afterEach(async () => {
  devices.close()
  await app.close()
  await relay.close()
  host.dispose()
})

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// A paired phone that reported every capability, with push unless told otherwise.
async function phone(options: { push?: Push | null; name?: string; capabilities?: string[] } = {}) {
  const device = await pairDevice(app.base, cookie, { name: options.name ?? 'kaan-iphone' })
  recordHello(host.db, device.deviceId, {
    appVersion: '1.0',
    capabilities: options.capabilities ?? ALL,
    push: options.push === undefined ? relay.appPush(`grant-${options.name ?? 'kaan-iphone'}`) : options.push,
  })
  return device
}

class AppClient {
  ws: WebSocket
  messages: Message[] = []
  waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = []
  closed: Promise<number>

  constructor(token: string) {
    this.ws = new WebSocket(`${app.base.replace(/^http/, 'ws')}/api/devices/ws`, { headers: { authorization: `Bearer ${token}` } })
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Message
      const waiter = this.waiters.find((w) => w.match(message))
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      } else this.messages.push(message)
    })
    this.closed = new Promise((resolve) => this.ws.on('close', (code) => resolve(code)))
  }

  static async connect(token: string, capabilities = ALL): Promise<AppClient> {
    const client = new AppClient(token)
    await new Promise<void>((resolve, reject) => {
      client.ws.once('open', () => resolve())
      client.ws.once('error', reject)
    })
    client.send({ type: 'hello', appVersion: '1.0', platform: 'ios', capabilities })
    await until(() => devices.list().some((d) => d.connected))
    return client
  }

  send(message: Message) {
    this.ws.send(JSON.stringify(message))
  }

  next(match: (m: Message) => boolean = (m) => m.type === 'call'): Promise<Message> {
    const found = this.messages.find(match)
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1)
      return Promise.resolve(found)
    }
    return new Promise((resolve) => this.waiters.push({ match, resolve }))
  }
}

function postResult(token: string, body: unknown) {
  return fetch(`${app.base}/api/devices/results`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function postEvent(token: string, body: unknown) {
  return fetch(`${app.base}/api/devices/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// The relay request and the payload the app gets after opening it.
function pushed(index = 0) {
  const { body, plaintext } = received[index]!
  const { v, sentAt, expiresAt, ...payload } = plaintext
  expect({ v, sentAt, expiresAt }).toEqual({ v: 1, sentAt: expect.any(Number), expiresAt: body.expiration })
  return { body, payload: payload as { aps: Record<string, unknown>; hobwork: { project: string; command: Message } } }
}

test('commands go over the socket when the app is connected, and the first result wins', async () => {
  const device = await phone()
  const client = await AppClient.connect(device.token)
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'alarms', 'set', { title: 'Wake up', time: '07:00', days: ['mon', 'fri'] }, 7)
  const message = await client.next()
  expect(message).toEqual({
    type: 'call',
    id: expect.any(String),
    capability: 'alarms',
    method: 'set',
    args: { title: 'Wake up', time: '07:00', days: ['mon', 'fri'], hob: 'bedtime' },
    expiresAt: expect.any(String),
  })
  client.send({ type: 'result', id: message.id, ok: true, value: { id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' } })
  expect(await call).toEqual({ id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' })
  expect(getCommand(host.db, String(message.id))).toMatchObject({ status: 'done', project: 'bedtime', invocation: 7 })

  // The same command answered again, as after a push that also reached the app.
  expect((await postResult(device.token, { id: message.id, ok: false, error: { code: 'x', message: 'late' } })).status).toBe(204)
  expect(host.db.prepare('SELECT status, result FROM device_commands WHERE id = ?').get(String(message.id))).toEqual({
    status: 'done',
    result: JSON.stringify({ id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' }),
  })
  expect(received).toEqual([])
})

test("the app's error fails the call with its code", async () => {
  const device = await phone()
  const client = await AppClient.connect(device.token)
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'screenTime', 'block', { set: 'games' }).catch((err: unknown) => err)
  const message = await client.next()
  client.send({ type: 'result', id: message.id, ok: false, error: { code: 'unknown_set', message: 'No app set called games' } })
  expect(await call).toMatchObject({ code: 'unknown_set', message: 'No app set called games' })
  expect(getCommand(host.db, String(message.id))?.status).toBe('failed')
})

test('a device that is not connected gets a background command as a passive push, answered by HTTP', async () => {
  const device = await phone()
  const until = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'screenTime', 'block', { set: 'social', until })
  await vi.waitFor(() => expect(received).toHaveLength(1))
  const { body, payload } = pushed()
  const command = payload.hobwork.command
  expect(payload).toEqual({
    aps: {
      alert: { title: 'bedtime', body: 'Screen Time change for this device. Open Hobwork if it did not apply.' },
      'mutable-content': 1,
      'interruption-level': 'passive',
      'thread-id': 'bedtime',
    },
    hobwork: {
      project: 'bedtime',
      command: { id: expect.any(String), capability: 'screenTime', method: 'block', args: { set: 'social', until }, expiresAt: expect.any(String) },
    },
  })
  expect(Date.parse(String(command.expiresAt)) - Date.now()).toBeGreaterThan(COMMAND_TTL_MS - 5000)
  expect(body).toMatchObject({ kind: 'command', collapseId: command.id })
  expect(Math.abs(Number(body.expiration) - Date.parse(String(command.expiresAt)) / 1000)).toBeLessThanOrEqual(1)

  expect((await postResult(device.token, { id: command.id, ok: true, value: {} })).status).toBe(204)
  expect(await call).toEqual({})
})

test('alarm commands are a prompt push, since only the app may use AlarmKit', async () => {
  await phone()
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'alarms', 'timer', { title: 'Tea', seconds: 180 }).catch((e: unknown) => e)
  await vi.waitFor(() => expect(received).toHaveLength(1))
  expect(received[0]!.body.kind).toBe('prompt')
  const { payload } = pushed()
  expect(payload.aps).toEqual({
    alert: { title: 'Start a timer', body: 'bedtime wants to start the timer "Tea". Tap to start it.' },
    sound: 'default',
    'thread-id': 'bedtime',
  })
  expect(payload.hobwork.command).toMatchObject({ capability: 'alarms', method: 'timer', foreground: true })
  devices.close()
  await call
})

test('NFC commands are a prompt push, and nfc.write creates a tag the project owns', async () => {
  const device = await phone()
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'nfc', 'write', { text: 'Desk' })
  await vi.waitFor(() => expect(received).toHaveLength(1))
  const { payload } = pushed()
  expect(received[0]!.body.kind).toBe('prompt')
  const command = payload.hobwork.command
  const tag = (command.args as { tag: string }).tag
  expect(payload).toEqual({
    aps: { alert: { title: 'Write an NFC tag', body: 'bedtime is waiting. Tap to start.' }, sound: 'default', 'thread-id': 'bedtime' },
    hobwork: {
      project: 'bedtime',
      command: {
        id: expect.any(String),
        capability: 'nfc',
        method: 'write',
        args: { tag, url: `${TEST_PUBLIC_URL}/nfc/${tag}`, text: 'Desk' },
        expiresAt: expect.any(String),
        foreground: true,
      },
    },
  })
  expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/)
  expect(host.db.prepare('SELECT p.name FROM nfc_tags t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(tag)).toEqual({
    name: 'bedtime',
  })
  // Foreground commands wait longer than background ones.
  await new Promise((r) => setTimeout(r, 500))
  expect((await postResult(device.token, { id: command.id, ok: true, value: {} })).status).toBe(204)
  expect(await call).toEqual({ tag, url: `${TEST_PUBLIC_URL}/nfc/${tag}` })
})

test('nfc.write with a url writes that URL and creates no tag', async () => {
  const device = await phone()
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'nfc', 'write', { url: 'HTTPS://Example.com/spools/3', text: 'Spool 3' })
  await vi.waitFor(() => expect(received).toHaveLength(1))
  const command = pushed().payload.hobwork.command
  expect(command.args).toEqual({ url: 'https://example.com/spools/3', text: 'Spool 3' })
  expect(host.db.prepare('SELECT count(*) AS n FROM nfc_tags').get()).toEqual({ n: 0 })
  await postResult(device.token, { id: command.id, ok: true, value: {} })
  expect(await call).toEqual({ url: 'https://example.com/spools/3' })
})

test('a failed nfc.write leaves no tag behind', async () => {
  const device = await phone()
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'nfc', 'write', {}).catch((err: unknown) => err)
  await vi.waitFor(() => expect(received).toHaveLength(1))
  const command = pushed().payload.hobwork.command
  await postResult(device.token, { id: command.id, ok: false, error: { code: 'cancelled', message: 'Closed the sheet' } })
  expect(await call).toMatchObject({ code: 'cancelled' })
  expect(host.db.prepare('SELECT count(*) AS n FROM nfc_tags').get()).toEqual({ n: 0 })
})

test('a socket that does not answer or disconnects falls back to push', async () => {
  const device = await phone()
  const silent = await AppClient.connect(device.token)
  const first = devices.callCommand('bedtime', 'kaan-iphone', 'focus', 'status', {})
  const call = await silent.next()
  await vi.waitFor(() => expect(received).toHaveLength(1))
  expect(pushed().payload.hobwork.command.id).toBe(call.id)
  await postResult(device.token, { id: call.id, ok: true, value: { active: ['work'] } })
  expect(await first).toEqual({ active: ['work'] })

  // NFC waits for the person on the open app, so only a dropped connection pushes.
  const second = devices.callCommand('bedtime', 'kaan-iphone', 'nfc', 'read', {})
  const read = await silent.next()
  await new Promise((r) => setTimeout(r, 250))
  expect(received).toHaveLength(1)
  silent.ws.close()
  await vi.waitFor(() => expect(received).toHaveLength(2))
  expect(pushed(1).payload.hobwork.command).toMatchObject({ id: read.id, foreground: true })
  await postResult(device.token, { id: read.id, ok: true, value: { records: [] } })
  expect(await second).toEqual({ records: [] })
})

test('pending commands go to the app again after every hello, oldest first', async () => {
  const device = await phone()
  const first = devices.callCommand('bedtime', 'kaan-iphone', 'alarms', 'list', {}).catch((err: unknown) => err)
  expect(await first).toMatchObject({ code: 'timeout' })
  const second = devices.callCommand('bedtime', 'kaan-iphone', 'screenTime', 'status')
  await vi.waitFor(() => expect(received).toHaveLength(2))
  const [firstId, secondId] = [0, 1].map((i) => pushed(i).payload.hobwork.command.id)

  const client = await AppClient.connect(device.token)
  const resent = [await client.next(), await client.next()]
  expect(resent.map((m) => m.id)).toEqual([firstId, secondId])
  client.send({ type: 'result', id: secondId, ok: true, value: { blocked: [], schedules: [], limits: [] } })
  expect(await second).toEqual({ blocked: [], schedules: [], limits: [] })
  client.send({ type: 'result', id: firstId, ok: true, value: [] })
  await until(() => getCommand(host.db, String(firstId))?.status === 'done')

  // Answered commands are not sent again.
  client.ws.close()
  await until(() => !devices.list()[0]!.connected)
  const again = await AppClient.connect(device.token)
  await new Promise((r) => setTimeout(r, 100))
  expect(again.messages.filter((m) => m.type === 'call')).toEqual([])
})

test('a command without an answer times out, and a late result goes to the project log', async () => {
  const device = await phone()
  const err = await devices.callCommand('bedtime', 'kaan-iphone', 'alarms', 'timer', { title: 'Tea', seconds: 240 }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(DeviceError)
  expect(err).toMatchObject({ code: 'timeout', message: expect.stringContaining('may still run until') })
  const late = pushed().payload.hobwork.command
  expect((await postResult(device.token, { id: late.id, ok: true, value: { id: 'abc' } })).status).toBe(204)
  const [line] = queryLogs(host, { project: 'bedtime', limit: 5 })
  expect(line).toMatchObject({ level: 'info', message: 'Device kaan-iphone: alarms.timer finished after the handler stopped waiting: {"id":"abc"}' })

  await devices.callCommand('bedtime', 'kaan-iphone', 'alarms', 'cancel', { id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' }).catch(() => {})
  const failed = pushed(1).payload.hobwork.command
  await postResult(device.token, { id: failed.id, ok: false, error: { code: 'not_authorized', message: 'Alarms are off' } })
  expect(queryLogs(host, { project: 'bedtime', limit: 5 }).at(-1)).toMatchObject({
    level: 'warn',
    message: 'Device kaan-iphone: alarms.cancel failed after the handler stopped waiting: not_authorized: Alarms are off',
  })
})

test('commands expire after 10 minutes and are not sent again', async () => {
  const device = await phone()
  await devices.callCommand('bedtime', 'kaan-iphone', 'nfc', 'write', {}).catch(() => {})
  const command = pushed().payload.hobwork.command
  offset = COMMAND_TTL_MS + 1000
  devices.expire()
  expect(getCommand(host.db, String(command.id))?.status).toBe('expired')
  expect(host.db.prepare('SELECT count(*) AS n FROM nfc_tags').get()).toEqual({ n: 0 })
  expect(queryLogs(host, { project: 'bedtime', limit: 5 }).at(-1)).toMatchObject({
    level: 'warn',
    message: 'Device kaan-iphone: nfc.write expired without an answer from the device',
  })
  const client = await AppClient.connect(device.token)
  await new Promise((r) => setTimeout(r, 100))
  expect(client.messages.filter((m) => m.type === 'call')).toEqual([])
})

test('a command that reaches nothing fails at once and does not run later', async () => {
  const device = await phone({ push: null })
  const err = await devices.callCommand('bedtime', 'kaan-iphone', 'alarms', 'list').catch((e: unknown) => e)
  expect(err).toMatchObject({ code: 'unreachable', message: expect.stringContaining('has not registered for push') })
  expect(host.db.prepare('SELECT status FROM device_commands').all()).toEqual([{ status: 'failed' }])
  const client = await AppClient.connect(device.token)
  await new Promise((r) => setTimeout(r, 100))
  expect(client.messages.filter((m) => m.type === 'call')).toEqual([])
})

test('results for commands of other devices, unknown IDs and bad bodies are refused', async () => {
  const device = await phone()
  const laptop = await phone({ name: 'kaan-mac' })
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'focus', 'status').catch((e: unknown) => e)
  await vi.waitFor(() => expect(received).toHaveLength(1))
  const id = pushed().payload.hobwork.command.id
  expect((await postResult(laptop.token, { id, ok: true, value: { active: [] } })).status).toBe(404)
  expect((await postResult(device.token, { id: 'nope', ok: true })).status).toBe(404)
  expect((await postResult(device.token, { id })).status).toBe(400)
  expect((await postResult('hwd_wrong', { id, ok: true })).status).toBe(401)
  expect(await call).toMatchObject({ code: 'timeout' })
})

test('capabilities the device did not report and unknown methods are unsupported', async () => {
  await phone({ capabilities: ['notifications'] })
  await expect(devices.callCommand('bedtime', 'kaan-iphone', 'screenTime', 'block', { set: 'social' })).rejects.toMatchObject({
    code: 'unsupported',
    message: expect.stringContaining('Screen Time'),
  })
  await expect(devices.callCommand('bedtime', 'kaan-iphone', 'alarms', 'snooze', {})).rejects.toMatchObject({
    code: 'unsupported',
    message: expect.stringContaining('alarms.set'),
  })
  await expect(devices.callCommand('bedtime', 'nobody', 'alarms', 'list', {})).rejects.toMatchObject({ code: 'unknown_device' })
  expect(host.db.prepare('SELECT count(*) AS n FROM device_commands').get()).toEqual({ n: 0 })
})

test('arguments are checked on the host', async () => {
  await phone()
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const past = new Date(Date.now() - 60 * 1000).toISOString()
  const cases: [string, string, unknown, string][] = [
    ['alarms', 'set', { title: 'Up' }, 'exactly one of at'],
    ['alarms', 'set', { title: 'Up', at: future, time: '07:00' }, 'exactly one of at'],
    ['alarms', 'set', { title: 'Up', at: past }, 'at is in the past'],
    ['alarms', 'set', { title: 'Up', at: '2030-01-01T07:00' }, 'with a time zone'],
    ['alarms', 'set', { title: 'Up', time: '7:00' }, 'like "07:30"'],
    ['alarms', 'set', { title: 'Up', time: '07:00', days: ['monday'] }, 'days must be'],
    ['alarms', 'set', { title: 'Up', at: future, days: ['mon'] }, 'days only works with time'],
    ['alarms', 'set', { title: '', time: '07:00' }, 'title must be'],
    ['alarms', 'set', { title: 'Up', time: '07:00', id: 'x' }, 'id must be a UUID'],
    ['alarms', 'set', { title: 'Up', time: '07:00', sound: 'loud' }, 'does not take "sound"'],
    ['alarms', 'timer', { title: 'Tea', seconds: 0 }, 'seconds must be a whole number from 1'],
    ['alarms', 'timer', { title: 'Tea', seconds: 60, tint: 'orange' }, 'tint must be a color'],
    ['alarms', 'timer', { title: 'Tea', seconds: 60, repeat: { seconds: 0 } }, 'repeat.seconds must be a whole number'],
    ['alarms', 'timer', { title: 'Tea', seconds: 60, repeat: { seconds: 60, snooze: true } }, 'repeat does not take "snooze"'],
    ['alarms', 'timer', { title: 'Tea', seconds: 60, repeat: null }, 'repeat must be { seconds, title? }'],
    ['alarms', 'timer', { title: 'Tea', seconds: 60, repeat: { seconds: 60, title: 'x'.repeat(21) } }, 'title must be at most 20'],
    ['alarms', 'reschedule', { seconds: 60 }, 'needs the id'],
    ['alarms', 'reschedule', { id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' }, 'needs something to change'],
    ['nfc', 'read', { alertMessage: '' }, 'alertMessage must be a non-empty string'],
    ['nfc', 'write', { successMessage: 'x'.repeat(201) }, 'successMessage must be at most 200'],
    ['alarms', 'cancel', {}, 'needs the id'],
    ['alarms', 'list', { all: true }, 'takes no arguments'],
    ['screenTime', 'block', { set: 'Social Apps' }, 'set must be a name'],
    ['screenTime', 'block', { set: 'social', until: past }, 'until is in the past'],
    ['screenTime', 'schedule', { name: 'night', set: 'social', start: '22:00', end: '22:00' }, 'start and end must differ'],
    ['screenTime', 'limit', { name: 'daily', set: 'social', minutes: 1440 }, 'minutes must be a whole number from 1 to 1439'],
    ['nfc', 'write', { text: 'x'.repeat(1025) }, 'at most 1024 bytes'],
    ['nfc', 'write', { url: 'example.com' }, 'url must be an absolute URL'],
    ['nfc', 'write', { url: 'https://example.com/a b' }, 'url must be an absolute URL'],
    ['nfc', 'write', { url: 'javascript:alert(1)' }, 'url must use one of the schemes'],
    ['nfc', 'write', { url: 'file:///etc/passwd' }, 'url must use one of the schemes'],
    ['nfc', 'write', { url: 'https://me:secret@example.com/' }, 'user name or password'],
    ['nfc', 'write', { url: `https://example.com/${'x'.repeat(2048)}` }, 'at most 2048 bytes'],
    ['nfc', 'write', { url: 42 }, 'url must be'],
    ['health', 'query', { type: 'weight', from: past, to: future }, 'type must be one of'],
    ['health', 'query', { type: 'steps', from: future, to: past }, 'from must be before to'],
    ['health', 'query', { type: 'steps', from: past, to: future, limit: 5000 }, 'limit must be a whole number from 1 to 1000'],
    ['focus', 'status', 'now', 'takes an object'],
  ]
  for (const [capability, method, args, message] of cases) {
    const err = await devices.callCommand('bedtime', 'kaan-iphone', capability, method, args).catch((e: unknown) => e)
    expect(err, `${capability}.${method} ${JSON.stringify(args)}`).toMatchObject({ code: 'bad_request', message: expect.stringContaining(message) })
  }
  expect(received).toEqual([])

  const now = Date.now()
  expect(COMMANDS.alarms!.set!.parse({ title: 'Up', at: future }, now)).toEqual({ title: 'Up', at: future })
  expect(COMMANDS.screenTime!.schedule!.parse({ name: 'night', set: 'social', start: '22:00', end: '07:00', days: ['sat', 'sun'] }, now)).toEqual({
    name: 'night',
    set: 'social',
    start: '22:00',
    end: '07:00',
    days: ['sat', 'sun'],
  })
  expect(COMMANDS.health!.query!.parse({ type: 'sleep', from: past, to: future }, now)).toEqual({ type: 'sleep', from: past, to: future })
  expect(
    COMMANDS.alarms!.timer!.parse({ title: 'Dehydrator', seconds: 21600, subtitle: '4 spools', tint: '#ff9500', repeat: { seconds: 7200, title: '+2 h' } }, now),
  ).toEqual({ title: 'Dehydrator', seconds: 21600, subtitle: '4 spools', tint: '#FF9500', repeat: { seconds: 7200, title: '+2 h' } })
  const id = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'
  expect(COMMANDS.alarms!.reschedule!.parse({ id, repeat: null }, now)).toEqual({ id, repeat: null })
  expect(COMMANDS.alarms!.reschedule!.parse({ id, seconds: 900 }, now)).toEqual({ id, seconds: 900 })
  expect(COMMANDS.nfc!.read!.parse({ alertMessage: 'Hold it near bin 4' }, now)).toEqual({ alertMessage: 'Hold it near bin 4' })
})

test('workspaces and branch previews cannot run commands', async () => {
  await phone()
  const { devicesResponse } = await import('./internal.ts')
  const res = await devicesResponse(JSON.stringify({ action: 'call', device: 'kaan-iphone', capability: 'alarms', method: 'list' }), {
    devices,
    project: 'bedtime',
    access: 'read',
  })
  expect(await res.json()).toMatchObject({ ok: false, error: { code: 'read_only' } })
})

test('the host serves the apple-app-site-association file for tag links', async () => {
  const res = await fetch(`${app.base}/.well-known/apple-app-site-association`)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(await res.json()).toEqual({
    applinks: {
      details: [{ appIDs: ['63QQLP356Q.dev.bgenc.hobwork'], components: [{ '/': '/nfc/*' }, { '/': '/devices/paired' }] }],
    },
    webcredentials: { apps: ['63QQLP356Q.dev.bgenc.hobwork'] },
  })
  const other = await startTestApp(host, { devices, web: { appleAppId: 'ABCDE12345.example.app' } })
  try {
    const custom = (await (await fetch(`${other.base}/.well-known/apple-app-site-association`)).json()) as {
      applinks: { details: { appIDs: string[] }[] }
    }
    expect(custom.applinks.details[0]!.appIDs).toEqual(['ABCDE12345.example.app'])
  } finally {
    await other.close()
  }
})

async function writtenTag(): Promise<string> {
  const device = await phone()
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'nfc', 'write', {})
  await vi.waitFor(() => expect(received).toHaveLength(1))
  await postResult(device.token, { id: pushed().payload.hobwork.command.id, ok: true, value: {} })
  return ((await call) as { tag: string }).tag
}

test('the tag page runs the scan for a signed-in person, and offers the app and sign-in otherwise', async () => {
  triggers.bedtime = { desk: { device: { capability: 'nfc', event: 'scanned' } }, phoneOnly: { device: { capability: 'nfc', event: 'scanned', device: 'kaan-iphone' } } }
  const tag = await writtenTag()
  const page = (headers: Record<string, string> = {}, init: RequestInit = {}) =>
    fetch(`${app.base}/nfc/${tag}`, { redirect: 'manual', ...init, headers })

  const anonymous = await page()
  expect(anonymous.status).toBe(200)
  const html = await anonymous.text()
  expect(html).toContain(`href="hobwork://nfc/${tag}"`)
  expect(html).toContain(`href="/login?returnTo=${encodeURIComponent(`/nfc/${tag}`)}"`)
  expect(html).not.toContain('bedtime')

  // Another site sending the person here gets a button, not a scan.
  const crossSite = await page({ cookie, 'sec-fetch-site': 'cross-site' })
  expect(await crossSite.text()).toContain('<form method="post"')
  expect(invoked).toEqual([])

  // A request that names no site could be from any site.
  const unknownSite = await page({ cookie })
  expect(await unknownSite.text()).toContain('<form method="post"')
  expect(invoked).toEqual([])

  const opened = await page({ cookie, 'sec-fetch-site': 'none' })
  expect(opened.status).toBe(303)
  expect(opened.headers.get('location')).toBe(`/nfc/${tag}?scanned`)
  await until(() => invoked.length === 1)
  expect(invoked).toEqual([
    { project: 'bedtime', name: 'desk', payload: { device: null, capability: 'nfc', event: 'scanned', tag, url: `${TEST_PUBLIC_URL}/nfc/${tag}` } },
  ])
  const result = await fetch(`${app.base}/nfc/${tag}?scanned`, { headers: { cookie } })
  expect(await result.text()).toContain('bedtime got the scan')
  expect(invoked).toHaveLength(1)

  const tapped = await page({ cookie, origin: TEST_PUBLIC_URL, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, { method: 'POST' })
  expect(tapped.status).toBe(303)
  await until(() => invoked.length === 2)
  const forged = await page({ cookie, origin: 'https://evil.example' }, { method: 'POST' })
  expect(forged.status).toBe(200)
  expect(invoked).toHaveLength(2)

  expect((await fetch(`${app.base}/nfc/AAAAAAAAAAAAAAAAAAAAAA`, { headers: { cookie } })).status).toBe(404)
  expect((await fetch(`${app.base}/nfc/nope`)).status).toBe(404)
})

test('tag scans from the app run the triggers of the project that wrote the tag', async () => {
  await createProject(host, 'other')
  triggers.bedtime = {
    desk: { device: { capability: 'nfc', event: 'scanned' } },
    macOnly: { device: { capability: 'nfc', event: 'scanned', device: 'kaan-mac' } },
    focus: { device: { capability: 'focus', event: 'changed' } },
  }
  triggers.other = { steal: { device: { capability: 'nfc', event: 'scanned' } } }
  const tag = await writtenTag()
  const device = { token: (await pairDevice(app.base, cookie, { name: 'scanner' })).token }
  await postEvent(device.token, { capability: 'nfc', name: 'scanned', data: { tag } })
  await postEvent(device.token, { capability: 'nfc', name: 'scanned', data: { tag: 'AAAAAAAAAAAAAAAAAAAAAA' } })
  await until(() => invoked.length === 1)
  await new Promise((r) => setTimeout(r, 50))
  expect(invoked).toEqual([
    { project: 'bedtime', name: 'desk', payload: { device: 'scanner', capability: 'nfc', event: 'scanned', tag, url: `${TEST_PUBLIC_URL}/nfc/${tag}` } },
  ])

  // The app's scan sends the URL and records; a tag URL of this host is still the tag.
  invoked = []
  const records = [
    { type: 'url', value: `${TEST_PUBLIC_URL}/nfc/${tag}` },
    { type: 'text', value: 'Desk' },
  ]
  await postEvent(device.token, { capability: 'nfc', name: 'scanned', data: { url: `${TEST_PUBLIC_URL}/nfc/${tag}`, records } })
  await until(() => invoked.length === 1)
  expect(invoked[0]).toEqual({
    project: 'bedtime',
    name: 'desk',
    payload: { device: 'scanner', capability: 'nfc', event: 'scanned', tag, url: `${TEST_PUBLIC_URL}/nfc/${tag}`, records },
  })

  triggers.bedtime = {}
  await postEvent(device.token, { capability: 'nfc', name: 'scanned', data: { tag } })
  expect(queryLogs(host, { project: 'bedtime', limit: 1 })[0]).toMatchObject({
    level: 'warn',
    event: 'trigger',
    message: expect.stringContaining('no trigger handles it'),
  })
})

test('scans of other URLs go to every project with a trigger whose url prefix matches', async () => {
  await createProject(host, 'spools')
  triggers.bedtime = {
    ownTags: { device: { capability: 'nfc', event: 'scanned' } },
    anyHttps: { device: { capability: 'nfc', event: 'scanned', url: 'https:' } },
    macOnly: { device: { capability: 'nfc', event: 'scanned', url: 'https:', device: 'kaan-mac' } },
  }
  triggers.spools = {
    spool: { device: { capability: 'nfc', event: 'scanned', url: 'https://Example.com' } },
    other: { device: { capability: 'nfc', event: 'scanned', url: 'https://example.org/' } },
  }
  const device = await phone()
  const records = [{ type: 'url', value: 'https://example.com/spools/3' }, { type: 'other', value: 'AQID' }]
  await postEvent(device.token, { capability: 'nfc', name: 'scanned', data: { url: 'https://example.com/spools/3', records } })
  await until(() => invoked.length === 2)
  const payload = { device: 'kaan-iphone', capability: 'nfc', event: 'scanned', url: 'https://example.com/spools/3', records }
  expect(invoked.map((i) => [i.project, i.name, i.payload]).sort()).toEqual([
    ['bedtime', 'anyHttps', payload],
    ['spools', 'spool', payload],
  ])

  invoked = []
  // A host that only starts with the prefix's text is another site.
  await postEvent(device.token, { capability: 'nfc', name: 'scanned', data: { url: 'https://example.com.evil.example/' } })
  await until(() => invoked.length === 1)
  await new Promise((r) => setTimeout(r, 50))
  expect(invoked.map((i) => i.name)).toEqual(['anyHttps'])

  invoked = []
  for (const data of [
    { url: 'not a url' },
    { records },
    { url: 'https://example.com/', records: [{ type: 'image', value: 'x' }] },
    { url: 'https://example.com/', records: Array(17).fill(records[0]) },
    { url: `https://example.com/${'x'.repeat(8192)}` },
    // An unknown tag of this host is not a URL for other projects.
    { url: `${TEST_PUBLIC_URL}/nfc/AAAAAAAAAAAAAAAAAAAAAA` },
  ]) {
    await postEvent(device.token, { capability: 'nfc', name: 'scanned', data })
  }
  await new Promise((r) => setTimeout(r, 50))
  expect(invoked).toEqual([])
})

test('Focus and Health events go to every project with a matching trigger, filtered by device', async () => {
  await createProject(host, 'fitness')
  await createProject(host, 'undeployed')
  triggers.bedtime = {
    anyFocus: { device: { capability: 'focus', event: 'changed' } },
    macFocus: { device: { capability: 'focus', event: 'changed', device: 'kaan-mac' } },
  }
  triggers.fitness = {
    phoneFocus: { device: { capability: 'focus', event: 'changed', device: 'kaan-iphone' } },
    samples: { device: { capability: 'health', event: 'samples' } },
  }
  const device = await phone()
  const client = await AppClient.connect(device.token)
  client.send({ type: 'event', capability: 'focus', name: 'changed', data: { label: 'work', active: true } })
  await until(() => invoked.length === 2)
  const focus = { device: 'kaan-iphone', capability: 'focus', event: 'changed', label: 'work', active: true }
  expect(invoked.map((i) => [i.project, i.name, i.payload]).sort()).toEqual([
    ['bedtime', 'anyFocus', focus],
    ['fitness', 'phoneFocus', focus],
  ])

  invoked = []
  const samples = [{ type: 'steps', start: '2026-09-28T10:00:00Z', end: '2026-09-28T11:00:00Z', value: 800, unit: 'count' }]
  await postEvent(device.token, { capability: 'health', name: 'samples', data: { type: 'steps', samples } })
  await postEvent(device.token, { capability: 'health', name: 'samples', data: { type: 'weight', samples } })
  await postEvent(device.token, { capability: 'health', name: 'samples', data: { type: 'steps', samples: Array(501).fill(samples[0]) } })
  await postEvent(device.token, { capability: 'focus', name: 'changed', data: { label: 'work' } })
  await until(() => invoked.length === 1)
  await new Promise((r) => setTimeout(r, 50))
  expect(invoked).toEqual([
    { project: 'fitness', name: 'samples', payload: { device: 'kaan-iphone', capability: 'health', event: 'samples', type: 'steps', samples } },
  ])
})

test('notification action triggers can be limited to one device', async () => {
  triggers.bedtime = {
    mac: { device: { capability: 'notifications', event: 'action', device: 'kaan-mac' } },
    phone: { device: { capability: 'notifications', event: 'action', device: 'kaan-iphone' } },
  }
  const device = await phone()
  const client = await AppClient.connect(device.token)
  const sent = devices.sendNotification('bedtime', 'kaan-iphone', { title: 'Bed?', actions: [{ id: 'yes', title: 'Yes' }] })
  const call = await client.next()
  client.send({ type: 'result', id: call.id, ok: true, value: null })
  const { id } = await sent
  client.send({ type: 'event', capability: 'notifications', name: 'action', data: { id, action: 'yes' } })
  await until(() => invoked.length === 1)
  expect(invoked[0]).toMatchObject({ project: 'bedtime', name: 'phone', payload: { device: 'kaan-iphone', action: 'yes' } })
})

test('hobwork.json accepts the device trigger pairs and a device name', () => {
  const check = (device: unknown) => validateHobworkJson(JSON.stringify({ triggers: { t: { device, handler: 'src/t.ts' } } }))
  for (const [capability, event] of [
    ['notifications', 'action'],
    ['focus', 'changed'],
    ['nfc', 'scanned'],
    ['health', 'samples'],
    ['alarms', 'fired'],
    ['alarms', 'stopped'],
    ['alarms', 'repeated'],
  ]) {
    expect(check({ capability, event }), `${capability}/${event}`).toEqual([])
    expect(check({ capability, event, device: 'kaans-iphone' })).toEqual([])
  }
  expect(check({ capability: 'focus', event: 'scanned' })).not.toEqual([])
  expect(check({ capability: 'alarms', event: 'scanned' })).not.toEqual([])
  expect(check({ capability: 'alarms', event: 'rang' })).not.toEqual([])
  expect(check({ capability: 'nfc', event: 'scanned', device: "Kaan's iPhone" })).not.toEqual([])
  expect(check({ capability: 'nfc', event: 'scanned', url: 'https://example.com/' })).toEqual([])
  expect(check({ capability: 'nfc', event: 'scanned', url: '' })).not.toEqual([])
  expect(check({ capability: 'focus', event: 'changed', url: 'https://example.com/' })).not.toEqual([])
})

test('nfc.write answers with the hardware ID and read-back check the app reports', async () => {
  const device = await phone()
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'nfc', 'write', {
    url: 'https://example.com/spool/78',
    alertMessage: 'Hold it near spool 78',
  })
  await vi.waitFor(() => expect(received).toHaveLength(1))
  const command = pushed().payload.hobwork.command
  expect(command.args).toEqual({ url: 'https://example.com/spool/78', alertMessage: 'Hold it near spool 78' })
  await postResult(device.token, { id: command.id, ok: true, value: { uid: '04a2245a8b6380', verified: true, extra: 'dropped' } })
  expect(await call).toEqual({ url: 'https://example.com/spool/78', uid: '04a2245a8b6380', verified: true })
})

test('timers carry their hob, so alarm events from the app reach its triggers', async () => {
  const device = await phone()
  const client = await AppClient.connect(device.token)
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'alarms', 'reschedule', { id: 'F81D4FAE-7DEC-11D0-A765-00A0C91E6BF6', repeat: null })
  const message = await client.next()
  expect(message.args).toEqual({ id: 'F81D4FAE-7DEC-11D0-A765-00A0C91E6BF6', repeat: null, hob: 'bedtime' })
  client.send({ type: 'result', id: message.id, ok: true, value: { id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' } })
  await call

  triggers.bedtime = {
    rang: { device: { capability: 'alarms', event: 'fired' } },
    again: { device: { capability: 'alarms', event: 'repeated' } },
    other: { device: { capability: 'alarms', event: 'stopped', device: 'kaan-mac' } },
  }
  const id = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'
  await postEvent(device.token, { capability: 'alarms', name: 'fired', data: { id, hob: 'bedtime', title: 'Tea' } })
  await postEvent(device.token, { capability: 'alarms', name: 'repeated', data: { id, hob: 'bedtime', seconds: 900 } })
  await postEvent(device.token, { capability: 'alarms', name: 'stopped', data: { id, hob: 'bedtime' } })
  await postEvent(device.token, { capability: 'alarms', name: 'fired', data: { id, hob: 'nope' } })
  await postEvent(device.token, { capability: 'alarms', name: 'fired', data: { id: 'x', hob: 'bedtime' } })
  await postEvent(device.token, { capability: 'alarms', name: 'rang', data: { id, hob: 'bedtime' } })
  await until(() => invoked.length === 2)
  await new Promise((r) => setTimeout(r, 50))
  expect(invoked).toEqual([
    { project: 'bedtime', name: 'rang', payload: { device: 'kaan-iphone', capability: 'alarms', event: 'fired', id, title: 'Tea' } },
    { project: 'bedtime', name: 'again', payload: { device: 'kaan-iphone', capability: 'alarms', event: 'repeated', id, seconds: 900 } },
  ])
  expect(devices.list()[0]!.lastActiveAt).not.toBeNull()
})

function handoff(token: string, body: unknown) {
  return fetch(`${app.base}/api/devices/handoff`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test("an iPad hands an NFC write to the person's phone and gets the result", async () => {
  const ipad = await phone({ name: 'kaan-ipad', capabilities: ['notifications'] })
  const iphone = await phone({ name: 'kaan-iphone' })
  const ari = await phone({ name: 'ari-iphone' })
  host.db.prepare('UPDATE devices SET user_id = ? WHERE id = ?').run(signedIn(host, 'ari@example.com').user.id, ari.deviceId)

  const pending = handoff(ipad.token, {
    hob: 'bedtime',
    device: 'lastActive',
    capability: 'nfc',
    method: 'write',
    args: { url: 'https://example.com/bin/4' },
  })
  await vi.waitFor(() => expect(received).toHaveLength(1))
  const { body, payload } = pushed()
  expect(body.kind).toBe('prompt')
  expect(payload.aps.alert).toEqual({ title: 'Write an NFC tag', body: 'bedtime on kaan-ipad is waiting. Tap to write the tag with this device.' })
  await postResult(iphone.token, { id: payload.hobwork.command.id, ok: true, value: { uid: '04aabbccddeeff', verified: true } })
  const res = await pending
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    ok: true,
    device: 'kaan-iphone',
    value: { url: 'https://example.com/bin/4', uid: '04aabbccddeeff', verified: true },
  })

  // Only the person's own devices, and only NFC.
  const refused = async (token: string, request: unknown) => ((await (await handoff(token, request)).json()) as { error: { code: string } }).error.code
  expect(await refused(ipad.token, { hob: 'bedtime', device: 'ari-iphone', capability: 'nfc', method: 'write', args: {} })).toBe('unknown_device')
  expect(await refused(ipad.token, { hob: 'bedtime', device: 'kaan-iphone', capability: 'alarms', method: 'list' })).toBe('bad_request')
  expect(await refused(ipad.token, { hob: 'nope', device: 'kaan-iphone', capability: 'nfc', method: 'read' })).toBe('bad_request')
  expect(await refused(iphone.token, { hob: 'bedtime', device: 'lastActive', capability: 'nfc', method: 'read' })).toBe('unreachable')
  expect((await handoff('nope', {})).status).toBe(401)
})

test('the app can ask which hob wrote a Hobwork tag', async () => {
  const device = await phone()
  const call = devices.callCommand('bedtime', 'kaan-iphone', 'nfc', 'write', {})
  await vi.waitFor(() => expect(received).toHaveLength(1))
  await postResult(device.token, { id: pushed().payload.hobwork.command.id, ok: true, value: {} })
  const { tag, url } = (await call) as { tag: string; url: string }
  const lookup = (body: unknown) =>
    fetch(`${app.base}/api/devices/nfc/lookup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect(await (await lookup({ url })).json()).toEqual({ tag, url, hob: 'bedtime' })
  expect((await lookup({ url: 'https://example.com/nfc/abc' })).status).toBe(404)
  expect((await lookup({ url: `${TEST_PUBLIC_URL}/nfc/AAAAAAAAAAAAAAAAAAAAAA` })).status).toBe(404)
})
