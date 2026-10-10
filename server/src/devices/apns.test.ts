import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto'
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn } from '../test-web.ts'
import { createApns, PayloadTooLarge, type Apns } from './apns.ts'
import { createDevices, type Devices } from './devices.ts'
import { devicesResponse } from './internal.ts'
import { createPairingCode, exchangePairingCode, getDevice, recordHello } from './store.ts'
import { pkce } from './test-devices.ts'

type Received = { headers: IncomingHttpHeaders; body: string }

let host: ReturnType<typeof createTestHost>
let server: Http2Server
let origin: string
let received: Received[]
let answer: (req: Received) => { status: number; body?: unknown }
let keys: { privateKey: KeyObject; publicKey: KeyObject }
let apns: Apns
let devices: Devices
let clock: number

beforeEach(async () => {
  host = createTestHost()
  received = []
  answer = () => ({ status: 200 })
  keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  // APNs speaks HTTP/2 over TLS; the fake speaks cleartext HTTP/2, which the
  // same client code reaches with an http:// origin.
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk))
    req.on('end', () => {
      const request = { headers: req.headers, body }
      received.push(request)
      const reply = answer(request)
      res.writeHead(reply.status, { 'apns-id': String(req.headers['apns-id']) })
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  clock = Date.parse('2026-09-28T10:00:00Z')
  apns = createApns({
    key: keys.privateKey,
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    origins: { sandbox: `${origin}`, production: `${origin}` },
    now: () => clock,
  })
  devices = createDevices({ host, apns })
  await createProject(host, 'alarms')
})

afterEach(async () => {
  devices.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  host.dispose()
})

function pairedPhone(push: { token: string; environment: 'sandbox' | 'production' } | null = { token: 'a1b2c3d4e5f60718', environment: 'sandbox' }) {
  const { user } = signedIn(host)
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId: user.id, name: 'kaan-iphone', platform: 'ios', codeChallenge: challenge })
  const { device } = exchangePairingCode(host.db, code, verifier)
  recordHello(host.db, device.id, { appVersion: '1.0', capabilities: ['notifications'], push })
  return device
}

function decodeJwt(token: string) {
  const [header, claims, signature] = token.split('.') as [string, string, string]
  const valid = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  )
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as unknown,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as unknown,
    valid,
  }
}

test('a device that is not connected gets the notification by push, with a signed provider token', async () => {
  pairedPhone()
  const sent = await devices.sendNotification('alarms', 'kaan-iphone', {
    title: 'Wake up',
    body: 'Alarm at 7:00',
    actions: [{ id: 'snooze', title: 'Snooze' }],
  })
  expect(sent).toEqual({ id: expect.any(String), delivery: 'push' })
  expect(received).toHaveLength(1)
  const [{ headers, body }] = received as [Received]
  expect(headers[':method']).toBe('POST')
  expect(headers[':path']).toBe('/3/device/a1b2c3d4e5f60718')
  expect(headers).toMatchObject({
    'apns-topic': 'dev.bgenc.hobwork',
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-id': sent.id,
    'apns-collapse-id': sent.id,
    'apns-expiration': String(clock / 1000 + 24 * 60 * 60),
  })
  const jwt = decodeJwt(String(headers.authorization).replace(/^bearer /, ''))
  expect(jwt).toEqual({ header: { alg: 'ES256', kid: 'KEY1234567' }, claims: { iss: 'TEAM123456', iat: clock / 1000 }, valid: true })
  expect(JSON.parse(body)).toEqual({
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
  const payload = JSON.parse(received[0]!.body) as { aps: Record<string, unknown> }
  expect(payload.aps).toEqual({ alert: { title: 'Print done' }, sound: 'default', 'thread-id': 'alarms' })
})

test('the provider token is reused for 40 minutes, then renewed', async () => {
  pairedPhone()
  const token = () => String(received.at(-1)!.headers.authorization)
  await devices.sendNotification('alarms', 'kaan-iphone', { title: '1' })
  const first = token()
  clock += 39 * 60 * 1000
  await devices.sendNotification('alarms', 'kaan-iphone', { title: '2' })
  expect(token()).toBe(first)
  clock += 2 * 60 * 1000
  await devices.sendNotification('alarms', 'kaan-iphone', { title: '3' })
  expect(token()).not.toBe(first)
})

test('an expired provider token is renewed and the push sent again', async () => {
  pairedPhone()
  await devices.sendNotification('alarms', 'kaan-iphone', { title: '1' })
  let refused = false
  answer = () => {
    if (refused) return { status: 200 }
    refused = true
    return { status: 403, body: { reason: 'ExpiredProviderToken' } }
  }
  clock += 1000
  expect(await devices.sendNotification('alarms', 'kaan-iphone', { title: '2' })).toMatchObject({ delivery: 'push' })
  expect(received).toHaveLength(3)
  expect(received[2]!.headers.authorization).not.toBe(received[1]!.headers.authorization)
})

test('a push token APNs no longer knows is forgotten', async () => {
  const device = pairedPhone()
  answer = () => ({ status: 410, body: { reason: 'Unregistered', timestamp: Date.now() } })
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({
    code: 'push_failed',
    message: expect.stringContaining('Unregistered'),
  })
  expect(getDevice(host.db, device.id)?.push).toBeNull()
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({
    code: 'unreachable',
    message: 'kaan-iphone is not connected, and it has not registered for push notifications',
  })
})

test('other APNs errors keep the push token', async () => {
  const device = pairedPhone()
  answer = () => ({ status: 429, body: { reason: 'TooManyRequests' } })
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi' })).rejects.toMatchObject({ code: 'push_failed' })
  expect(getDevice(host.db, device.id)?.push).not.toBeNull()
})

test('the sandbox and production environments go to their own origins', async () => {
  const other: Received[] = []
  const production = createServer((req, res) => {
    other.push({ headers: req.headers, body: '' })
    req.resume()
    req.on('end', () => res.writeHead(200).end())
  })
  await new Promise<void>((resolve) => production.listen(0, '127.0.0.1', resolve))
  const client = createApns({
    key: keys.privateKey,
    keyId: 'K',
    teamId: 'T',
    origins: { sandbox: origin, production: `http://127.0.0.1:${(production.address() as AddressInfo).port}` },
  })
  try {
    expect(await client.send({ token: 'aa11', environment: 'production' }, { id: 'id-1', payload: {} })).toEqual({ ok: true })
    expect(await client.send({ token: 'bb22', environment: 'sandbox' }, { id: 'id-2', payload: {} })).toEqual({ ok: true })
    expect(other.map((r) => r.headers[':path'])).toEqual(['/3/device/aa11'])
    expect(received.map((r) => r.headers[':path'])).toEqual(['/3/device/bb22'])
  } finally {
    client.close()
    await new Promise<void>((resolve) => production.close(() => resolve()))
  }
})

test('payloads over 4 KB are not sent', async () => {
  await expect(apns.send({ token: 'aa', environment: 'sandbox' }, { id: 'x', payload: { big: 'x'.repeat(5000) } })).rejects.toBeInstanceOf(
    PayloadTooLarge,
  )
  expect(received).toEqual([])
})

test('every notification that passes validation fits in a push', async () => {
  pairedPhone()
  const longest = {
    title: 'ş'.repeat(100),
    body: 'ş'.repeat(1000),
    actions: [1, 2, 3, 4].map((n) => ({ id: `a${n}`.padEnd(64, 'x'), title: 'ş'.repeat(64) })),
  }
  expect(await devices.sendNotification('alarms', 'kaan-iphone', longest)).toMatchObject({ delivery: 'push' })
  expect(Buffer.byteLength(received[0]!.body)).toBeLessThanOrEqual(4096)

  // Measured in bytes: 1100 two-byte characters are over 2000.
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi', body: 'ş'.repeat(1100) })).rejects.toMatchObject({
    code: 'bad_request',
    message: 'body must be at most 2000 bytes as UTF-8',
  })
  // Within the field limits, but escaping doubles it past 4 KB.
  await expect(devices.sendNotification('alarms', 'kaan-iphone', { title: 'Hi', body: '"'.repeat(2000) })).rejects.toMatchObject({
    code: 'too_large',
    message: expect.stringMatching(/^The notification is \d+ bytes as a push, and Apple allows 4096/),
  })
  expect(received).toHaveLength(1)
})

test('a request APNs does not answer drops the connection and is sent again on a new one', async () => {
  const connections: unknown[] = []
  let first = true
  const hanging = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (first) {
        first = false
        return
      }
      res.writeHead(200).end()
    })
  })
  hanging.on('session', (s) => connections.push(s))
  await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`
  const client = createApns({ key: keys.privateKey, keyId: 'K', teamId: 'T', origins: { sandbox: url, production: url }, requestTimeoutMs: 200 })
  try {
    expect(await client.send({ token: 'aa11', environment: 'sandbox' }, { id: 'id-1', payload: {} })).toEqual({ ok: true })
    expect(connections).toHaveLength(2)
  } finally {
    client.close()
    hanging.close()
  }
})

test('idle connections are closed, and the next push opens a new one', async () => {
  const connections: unknown[] = []
  server.on('session', (s) => connections.push(s))
  const client = createApns({ key: keys.privateKey, keyId: 'K', teamId: 'T', origins: { sandbox: origin, production: origin }, idleTimeoutMs: 100 })
  try {
    await client.send({ token: 'aa11', environment: 'sandbox' }, { id: 'id-1', payload: {} })
    await client.send({ token: 'aa11', environment: 'sandbox' }, { id: 'id-2', payload: {} })
    expect(connections).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 300))
    await client.send({ token: 'aa11', environment: 'sandbox' }, { id: 'id-3', payload: {} })
    expect(connections).toHaveLength(2)
  } finally {
    client.close()
  }
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
  expect(received).toEqual([])

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
