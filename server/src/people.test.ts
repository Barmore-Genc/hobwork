import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDevices, type Devices } from './devices/devices.ts'
import { devicesResponse } from './devices/internal.ts'
import { ACTIVE_INTERVAL_MS, createPairingCode, exchangePairingCode, getDevice, markDeviceActive } from './devices/store.ts'
import { pkce } from './devices/test-devices.ts'
import { getPerson, hostTimeZone, listPeople, reportTimeZone, setTimeZone, timeZoneSetting } from './people.ts'
import { createTestHost } from './test-host.ts'
import { signedIn, startTestApp, writeHeaders } from './test-web.ts'

let host: ReturnType<typeof createTestHost>
let devices: Devices
const allowlist = { emails: ['kaan@example.com', 'ece@example.com'], subjects: [] }

beforeEach(() => {
  host = createTestHost()
  devices = createDevices({ host, allowlist })
})

afterEach(() => {
  devices.close()
  host.dispose()
})

function pair(userId: number, name: string) {
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId, name, platform: 'ios', codeChallenge: challenge })
  return exchangePairingCode(host.db, code, verifier).device
}

async function call(request: unknown) {
  return (await devicesResponse(JSON.stringify(request), { devices, project: 'filament', access: 'read' }).then((r) => r.json())) as {
    ok: boolean
    result?: unknown
    error?: { code: string }
  }
}

test('reports set the time zone until the person chooses one; null follows reports again', () => {
  const { user } = signedIn(host)
  expect(timeZoneSetting(host.db, user.id)).toEqual({ timeZone: null, manual: false })
  expect(getPerson(host.db, allowlist, user.id)?.timeZone).toBe(hostTimeZone())

  expect(reportTimeZone(host.db, user.id, 'Europe/Istanbul')).toBe(true)
  expect(reportTimeZone(host.db, user.id, 'Mars/Olympus')).toBe(false)
  expect(reportTimeZone(host.db, user.id, 42)).toBe(false)
  expect(getPerson(host.db, allowlist, user.id)?.timeZone).toBe('Europe/Istanbul')

  setTimeZone(host.db, user.id, 'Asia/Tokyo')
  expect(reportTimeZone(host.db, user.id, 'Europe/Berlin')).toBe(false)
  expect(timeZoneSetting(host.db, user.id)).toEqual({ timeZone: 'Asia/Tokyo', manual: true })

  setTimeZone(host.db, user.id, null)
  expect(timeZoneSetting(host.db, user.id)).toEqual({ timeZone: 'Asia/Tokyo', manual: false })
  expect(reportTimeZone(host.db, user.id, 'Europe/Berlin')).toBe(true)
  expect(() => setTimeZone(host.db, user.id, 'Mars/Olympus')).toThrow('not a known time zone')
})

test('people are the users on the allowlist, with stable IDs', async () => {
  const kaan = signedIn(host).user
  const ece = signedIn(host, 'ece@example.com').user
  host.db.prepare("UPDATE users SET name = 'Ece' WHERE id = ?").run(ece.id)
  signedIn(host, 'gone@example.com')
  expect(listPeople(host.db, allowlist).map((p) => [p.id, p.name, p.email])).toEqual([
    [ece.id, 'Ece', 'ece@example.com'],
    [kaan.id, 'Kaan', 'kaan@example.com'],
  ])
  expect(await call({ action: 'people' })).toEqual({ ok: true, result: listPeople(host.db, allowlist) })
})

test('a person’s devices come most recently used first', async () => {
  const kaan = signedIn(host).user
  const ece = signedIn(host, 'ece@example.com').user
  const phone = pair(kaan.id, 'kaan-iphone')
  const mac = pair(kaan.id, 'kaan-mac')
  pair(ece.id, 'ece-iphone')
  const now = Date.now()
  markDeviceActive(host.db, phone.id, now - 60_000)
  markDeviceActive(host.db, mac.id, now)

  const listed = await call({ action: 'list', person: kaan.id })
  expect((listed.result as { name: string; ownerId: number }[]).map((d) => [d.name, d.ownerId])).toEqual([
    ['kaan-mac', kaan.id],
    ['kaan-iphone', kaan.id],
  ])
  // Activity within the interval is not written again.
  markDeviceActive(host.db, mac.id, now + ACTIVE_INTERVAL_MS - 1)
  expect(getDevice(host.db, mac.id)?.lastActiveAt).toBe(new Date(now).toISOString())
  markDeviceActive(host.db, phone.id, now + 1)
  expect(((await call({ action: 'list', person: kaan.id })).result as { name: string }[])[0]?.name).toBe('kaan-iphone')

  expect(await call({ action: 'list', person: 999 })).toMatchObject({ ok: false, error: { code: 'unknown_person' } })
  expect(await call({ action: 'list', person: 'kaan' })).toMatchObject({ ok: false, error: { code: 'unknown_person' } })
})

test('people choose a time zone in Settings, and the web UI reports the browser’s', async () => {
  const app = await startTestApp(host, { devices, web: { allowlist } })
  try {
    const { user, cookie } = signedIn(host)
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${app.base}${path}`, { method, headers: writeHeaders(cookie), body: body === undefined ? undefined : JSON.stringify(body) })

    expect(await (await send('GET', '/api/me/time-zone')).json()).toEqual({ timeZone: null, manual: false, host: hostTimeZone() })
    expect(await (await send('POST', '/api/me/time-zone/report', { timeZone: 'Europe/Istanbul' })).json()).toMatchObject({
      timeZone: 'Europe/Istanbul',
      manual: false,
    })
    expect(await (await send('PUT', '/api/me/time-zone', { timeZone: 'Asia/Tokyo' })).json()).toMatchObject({ timeZone: 'Asia/Tokyo', manual: true })
    expect(await (await send('POST', '/api/me/time-zone/report', { timeZone: 'Europe/Berlin' })).json()).toMatchObject({ timeZone: 'Asia/Tokyo' })
    expect((await send('PUT', '/api/me/time-zone', { timeZone: 'Mars/Olympus' })).status).toBe(400)
    expect((await send('POST', '/api/me/time-zone/report', { timeZone: null })).status).toBe(400)
    expect(await (await send('PUT', '/api/me/time-zone', { timeZone: null })).json()).toMatchObject({ manual: false })
    expect(timeZoneSetting(host.db, user.id)).toEqual({ timeZone: 'Asia/Tokyo', manual: false })
    expect((await fetch(`${app.base}/api/me/time-zone`)).status).toBe(401)
  } finally {
    await app.close()
  }
})
