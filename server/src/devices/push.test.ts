import { createPrivateKey, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadConfig } from '../config.ts'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn } from '../test-web.ts'
import { createDevices, type Devices } from './devices.ts'
import { devicesResponse } from './internal.ts'
import { keyIdOf, loadPushKeys, type PushKeys } from './push/keys.ts'
import { createRelayPush, DEFAULT_RELAY_URL, PayloadTooLarge } from './push/relay.ts'
import { contentKey, seal } from './push/seal.ts'
import { createPairingCode, exchangePairingCode, getDevice, recordHello, type Push } from './store.ts'
import { pkce } from './test-devices.ts'
import { openSealed, startFakeRelay, testPushKeys } from './test-relay.ts'

const vector = JSON.parse(readFileSync(join(import.meta.dirname, 'push-vector.json'), 'utf8')) as Record<string, string> & { plaintext: unknown }

let host: ReturnType<typeof createTestHost>
let keys: PushKeys
let relay: Awaited<ReturnType<typeof startFakeRelay>>
let devices: Devices
let clock: number

beforeEach(async () => {
  host = createTestHost()
  keys = testPushKeys()
  relay = await startFakeRelay(keys)
  clock = Date.parse('2026-09-28T10:00:00Z')
  const now = () => clock
  devices = createDevices({ host, relay: createRelayPush({ url: relay.url, keys, now }), now })
  await createProject(host, 'alarms')
})

afterEach(async () => {
  devices.close()
  await relay.close()
  host.dispose()
})

function pairedPhone(push: Push | null = relay.appPush()) {
  const { user } = signedIn(host)
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId: user.id, name: 'kaan-iphone', platform: 'ios', codeChallenge: challenge })
  const { device } = exchangePairingCode(host.db, code, verifier)
  recordHello(host.db, device.id, { appVersion: '1.0', capabilities: ['notifications'], push })
  return device
}

function x25519(base64: string) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(base64, 'base64')])
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
}

test('sealing matches the vector the app tests check', () => {
  const hostKey = x25519(vector.hostEncryptionPrivateKey!)
  const hostPublic = Buffer.from(vector.hostEncryptionKey!, 'base64')
  const appKey = Buffer.from(vector.appKey!, 'base64')
  expect(keyIdOf(hostPublic)).toBe(vector.keyId)
  expect(contentKey(hostKey, hostPublic, appKey).toString('base64')).toBe(vector.contentKey)
  // Deflate output differs between zlib versions, so a fresh seal is checked by opening it, not against the vector's bytes.
  const sealed = seal({ plaintext: vector.plaintext, hostKey, hostPublic, appKey, grant: vector.grant! })
  expect(openSealed({ ciphertext: sealed, appKey: x25519(vector.appPrivateKey!), hostPublic, grant: vector.grant! })).toEqual(
    vector.plaintext,
  )
  expect(openSealed({ ciphertext: vector.ciphertext!, appKey: x25519(vector.appPrivateKey!), hostPublic, grant: vector.grant! })).toEqual(
    vector.plaintext,
  )
  expect(() =>
    openSealed({ ciphertext: vector.ciphertext!, appKey: x25519(vector.appPrivateKey!), hostPublic, grant: 'another-grant' }),
  ).toThrow()
})

test('a device that is not connected gets the notification as a signed, sealed push', async () => {
  pairedPhone(relay.appPush('R3JhbnQtZm9yLXRoZS1hcHA'))
  const sent = await devices.sendNotification('alarms', 'kaan-iphone', {
    title: 'Wake up',
    body: 'Alarm at 7:00',
    actions: [{ id: 'snooze', title: 'Snooze' }],
  })
  expect(sent).toEqual({ id: expect.any(String), delivery: 'push' })
  expect(relay.received).toHaveLength(1)
  const [request] = relay.received
  expect(request!.path).toBe('/v1/grants/R3JhbnQtZm9yLXRoZS1hcHA/push')
  expect(request!.signatureValid).toBe(true)
  expect(request!.headers['hobwork-timestamp']).toBe(String(clock / 1000))
  expect(String(request!.headers['hobwork-nonce'])).toMatch(/^[A-Za-z0-9_-]{24}$/)
  expect(request!.body).toEqual({
    kind: 'alert',
    expiration: clock / 1000 + 24 * 60 * 60,
    collapseId: sent.id,
    keyId: keys.public.keyId,
    ciphertext: expect.any(String),
  })
  expect(request!.plaintext).toEqual({
    v: 1,
    sentAt: clock / 1000,
    expiresAt: clock / 1000 + 24 * 60 * 60,
    aps: {
      alert: { title: 'Wake up', body: 'Alarm at 7:00' },
      sound: 'default',
      'thread-id': 'alarms',
      category: `hobwork.${sent.id}`,
      'mutable-content': 1,
    },
    hobwork: { id: sent.id, project: 'alarms', actions: [{ id: 'snooze', title: 'Snooze' }] },
  })
})

test('notifications without actions have no category', async () => {
  pairedPhone()
  await devices.sendNotification('alarms', 'kaan-iphone', { title: 'Print done' })
  expect(relay.received[0]!.plaintext.aps).toEqual({ alert: { title: 'Print done' }, sound: 'default', 'thread-id': 'alarms' })
})

test.each(['gone', 'expired', 'unknown_grant'])('a grant the relay answers %s for is forgotten', async (error) => {
  const device = pairedPhone()
  relay.answer(() => ({ status: error === 'unknown_grant' ? 404 : 410, body: { error, message: 'No such grant.' } }))
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({
    code: 'push_failed',
    message: expect.stringContaining(error),
  })
  expect(getDevice(host.db, device.id)?.push).toBeNull()
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({
    code: 'unreachable',
    message: 'kaan-iphone is not connected, and it has not registered for push notifications',
  })
})

test('other relay errors keep the grant', async () => {
  const device = pairedPhone()
  relay.answer(() => ({ status: 502, body: { error: 'push_failed', message: 'APNs answered 429.' } }))
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({ code: 'push_failed' })
  expect(getDevice(host.db, device.id)?.push).not.toBeNull()
})

test('a host without a relay says so', async () => {
  devices.close()
  devices = createDevices({ host })
  pairedPhone()
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({
    code: 'unreachable',
    message: 'kaan-iphone is not connected, and this Hobwork host does not send push notifications',
  })
  expect(devices.pushMessage()).toEqual({ type: 'push', relay: null })
})

// Random printable text compresses least, and escaping makes it longer.
function noise(length: number): string {
  return [...randomBytes(length)].map((b) => String.fromCharCode(32 + (b % 95))).join('')
}

test('every notification that passes validation fits in a push', async () => {
  pairedPhone()
  const largest = {
    title: noise(200),
    body: noise(2000),
    actions: [1, 2, 3, 4].map((n) => ({ id: `a${n}${randomBytes(48).toString('base64url')}`.slice(0, 64), title: noise(64) })),
  }
  expect(await devices.sendNotification('alarms', 'kaan-iphone', largest)).toMatchObject({ delivery: 'push' })
  const { body } = relay.received[0]!
  const envelope = { aps: { alert: { title: 'Hobwork', body: 'You have a new notification.' }, 'mutable-content': 1, sound: 'default' }, hobwork: { v: 1, grant: 'R3JhbnQtZm9yLXRoZS1hcHA', keyId: body.keyId, ciphertext: body.ciphertext } }
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(4096)
})

test('pushes the relay would refuse as too large are not sent', async () => {
  const sender = createRelayPush({ url: relay.url, keys })
  const message = { id: 'id-1', kind: 'alert' as const, payload: { aps: {}, hobwork: { big: noise(6000) } }, expiresAt: 0 }
  await expect(sender.send(relay.appPush(), message)).rejects.toBeInstanceOf(PayloadTooLarge)
  expect(relay.received).toEqual([])
})

test('the internal endpoint sends for deployed handlers and refuses workspaces and previews', async () => {
  pairedPhone()
  const logs: unknown[] = []
  const call = (access: 'full' | 'read', request: unknown) =>
    devicesResponse(JSON.stringify(request), { devices, project: 'alarms', access, log: (entry) => logs.push(entry) })

  const list = await call('read', { action: 'list' })
  expect(await list.json()).toEqual({
    ok: true,
    result: [
      {
        name: 'kaan-iphone',
        platform: 'ios',
        owner: 'Kaan',
        ownerId: expect.any(Number),
        capabilities: ['notifications'],
        connected: false,
        lastSeenAt: expect.any(String),
        lastActiveAt: null,
      },
    ],
  })

  const send = { action: 'call', device: 'kaan-iphone', capability: 'notifications', method: 'send', args: { title: 'Hi' }, invocation: 7 }
  const refused = await call('read', send)
  expect(refused.status).toBe(403)
  expect(await refused.json()).toMatchObject({ ok: false, error: { code: 'read_only' } })
  expect(relay.received).toEqual([])

  const ok = await call('full', send)
  expect(await ok.json()).toEqual({ ok: true, result: { id: expect.any(String), delivery: 'push' } })
  expect(logs).toEqual([{ invocation: 7, level: 'info', message: 'Device kaan-iphone: sent notification "Hi" (by push)' }])

  const unknown = await call('full', { ...send, device: 'nope' })
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({
    ok: false,
    error: { code: 'unknown_device', message: 'No device called "nope". Paired devices: kaan-iphone' },
  })

  const unsupported = await call('full', { ...send, capability: 'nfc', method: 'write' })
  expect(await unsupported.json()).toMatchObject({ ok: false, error: { code: 'unsupported' } })

  const invalid = await call('full', { ...send, args: { title: 'Hi', actions: [{ id: 'has space', title: 'X' }] } })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ ok: false, error: { code: 'bad_request' } })
})

test('devices that never said they can show notifications are refused', async () => {
  const device = pairedPhone()
  recordHello(host.db, device.id, { appVersion: '1.0', capabilities: [] })
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({ code: 'unsupported' })
})

test('push keys are made once, readable only by the host, and kept', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hobwork-push-')), 'keys')
  try {
    const first = loadPushKeys(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'keys.json')).mode & 0o777).toBe(0o600)
    expect(first.public.keyId).toBe(keyIdOf(Buffer.from(first.public.encryptionKey, 'base64')))
    expect(loadPushKeys(dir).public).toEqual(first.public)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the relay is on by default, can be turned off, and must be an origin', () => {
  expect(loadConfig({}).push).toEqual({ relayUrl: DEFAULT_RELAY_URL, keyDir: expect.stringMatching(/\/data-push-keys$/) })
  expect(loadConfig({ HOBWORK_PUSH_RELAY_URL: 'off' }).push).toBeUndefined()
  expect(loadConfig({ HOBWORK_PUSH_RELAY_URL: 'http://localhost:8080', HOBWORK_PUSH_KEY_DIR: '/var/lib/push' }).push).toEqual({
    relayUrl: 'http://localhost:8080',
    keyDir: '/var/lib/push',
  })
  expect(() => loadConfig({ HOBWORK_PUSH_RELAY_URL: 'https://relay.example/v1' })).toThrow('must be an origin')
})
