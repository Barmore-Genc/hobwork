import { afterEach, beforeEach, expect, test } from 'vitest'
import { findSession } from '../auth/sessions.ts'
import { createTestHost } from '../test-host.ts'
import { createProject } from '../projects.ts'
import { appSessionCookie, signedIn, startTestApp, TEST_PUBLIC_URL, writeHeaders } from '../test-web.ts'
import {
  createPairingCode,
  createWebSessionLink,
  exchangePairingCode,
  getDevice,
  PAIRING_CODE_TTL_MS,
  redeemWebSessionLink,
  setPush,
  slugifyDeviceName,
  verifyDeviceToken,
  WEB_SESSION_LINK_TTL_MS,
} from './store.ts'
import { pairDevice, pkce } from './test-devices.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string
let userId: number

beforeEach(async () => {
  host = createTestHost()
  const session = signedIn(host)
  cookie = session.cookie
  userId = session.user.id
  app = await startTestApp(host)
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

function connectQuery(overrides: Record<string, string | undefined> = {}): string {
  const params = { name: "Kaan's iPhone", platform: 'ios', challenge: pkce().challenge, state: 's1', redirect_uri: 'hobwork://paired', ...overrides }
  return new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString()
}

test('the app finds Hobwork at /.well-known/hobwork without signing in', async () => {
  const res = await fetch(`${app.base}/.well-known/hobwork`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ hobwork: 1, name: 'hobwork.test', version: expect.any(String) })
})

test('the pairing page checks the request and suggests a free name', async () => {
  const check = (query: string) => fetch(`${app.base}/api/devices/pairing?${query}`, { headers: { cookie } })
  const res = await check(connectQuery())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ displayName: "Kaan's iPhone", platform: 'ios', name: 'kaans-iphone' })

  expect((await check(connectQuery({ redirect_uri: 'https://evil.example/paired' }))).status).toBe(400)
  expect((await check(connectQuery({ redirect_uri: 'hobwork://paired/' }))).status).toBe(400)
  expect((await check(connectQuery({ challenge: 'short' }))).status).toBe(400)
  expect((await check(connectQuery({ platform: 'android' }))).status).toBe(400)
  expect((await check(connectQuery({ name: undefined }))).status).toBe(400)

  expect((await fetch(`${app.base}/api/devices/pairing?${connectQuery()}`)).status).toBe(401)
})

test('the pairing redirect can be the universal link on the public host', async () => {
  const universal = `${TEST_PUBLIC_URL}/devices/paired`
  const check = (uri: string) => fetch(`${app.base}/api/devices/pairing?${connectQuery({ redirect_uri: uri })}`, { headers: { cookie } })
  expect((await check(universal)).status).toBe(200)
  expect((await check(`${universal}/`)).status).toBe(400)
  expect((await check('https://evil.example/devices/paired')).status).toBe(400)

  const { verifier, challenge } = pkce()
  const request = { name: "Kaan's iPhone", platform: 'ios', challenge, state: 'abc', redirect_uri: universal }
  const approve = await fetch(`${app.base}/api/devices/pairing/approve`, {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({ request, name: 'kaan-iphone' }),
  })
  const redirectTo = new URL(((await approve.json()) as { redirectTo: string }).redirectTo)
  expect(redirectTo.origin + redirectTo.pathname).toBe(universal)
  expect(redirectTo.searchParams.get('state')).toBe('abc')
  const exchange = await fetch(`${app.base}/api/devices/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: redirectTo.searchParams.get('code'), codeVerifier: verifier }),
  })
  expect(exchange.status).toBe(200)

  const deny = await fetch(`${app.base}/api/devices/pairing/deny`, {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({ request }),
  })
  expect(await deny.json()).toEqual({ redirectTo: `${universal}?error=access_denied&state=abc` })
})

test('the pairing link opened in a browser says what to do', async () => {
  const res = await fetch(`${app.base}/devices/paired?code=abc`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  expect(await res.text()).toContain('Open the Hobwork app')
})

test('approving redirects to hobwork://paired with a code the app exchanges once with its verifier', async () => {
  const { verifier, challenge } = pkce()
  const request = { name: "Kaan's iPhone", platform: 'ios', challenge, state: 'abc', redirect_uri: 'hobwork://paired' }
  const approve = await fetch(`${app.base}/api/devices/pairing/approve`, {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({ request, name: 'kaan-iphone' }),
  })
  expect(approve.status).toBe(200)
  const redirectTo = new URL(((await approve.json()) as { redirectTo: string }).redirectTo)
  expect(`${redirectTo.protocol}//${redirectTo.host}${redirectTo.pathname}`).toBe('hobwork://paired')
  expect(redirectTo.searchParams.get('state')).toBe('abc')
  const code = redirectTo.searchParams.get('code')!

  const exchange = (body: unknown) =>
    fetch(`${app.base}/api/devices/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const res = await exchange({ code, codeVerifier: verifier })
  expect(res.status).toBe(200)
  const paired = (await res.json()) as { deviceId: number; name: string; token: string; push: null }
  expect(paired).toEqual({ deviceId: expect.any(Number), name: 'kaan-iphone', token: expect.stringMatching(/^hwd_/), push: null })
  expect(verifyDeviceToken(host.db, paired.token)).toMatchObject({ id: paired.deviceId, userId, platform: 'ios' })

  // Single use.
  expect((await exchange({ code, codeVerifier: verifier })).status).toBe(400)
})

test('a wrong verifier uses the code up', async () => {
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId, name: 'kaan-iphone', platform: 'ios', codeChallenge: challenge })
  expect(() => exchangePairingCode(host.db, code, pkce().verifier)).toThrow('code verifier does not match')
  expect(() => exchangePairingCode(host.db, code, verifier)).toThrow('unknown, expired or was already used')
})

test('codes expire after 5 minutes', () => {
  const { verifier, challenge } = pkce()
  const start = Date.now()
  const code = createPairingCode(host.db, { userId, name: 'kaan-iphone', platform: 'ios', codeChallenge: challenge }, start)
  expect(() => exchangePairingCode(host.db, code, verifier, start + PAIRING_CODE_TTL_MS + 1)).toThrow('expired')
})

test('a name taken meanwhile gets a number at exchange, and approving a taken name is refused', async () => {
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId, name: 'kaan-iphone', platform: 'ios', codeChallenge: challenge })
  await pairDevice(app.base, cookie)
  expect(exchangePairingCode(host.db, code, verifier).device.name).toBe('kaan-iphone-2')

  const retry = await fetch(`${app.base}/api/devices/pairing/approve`, {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({ request: Object.fromEntries(new URLSearchParams(connectQuery())), name: 'kaan-iphone' }),
  })
  expect(retry.status).toBe(409)
})

test('approving needs a signed-in person and the CSRF header', async () => {
  const body = JSON.stringify({ request: Object.fromEntries(new URLSearchParams(connectQuery())), name: 'x-phone' })
  const anonymous = await fetch(`${app.base}/api/devices/pairing/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hobwork-csrf': '1' },
    body,
  })
  expect(anonymous.status).toBe(401)
  const crossSite = await fetch(`${app.base}/api/devices/pairing/approve`, {
    method: 'POST',
    headers: { ...writeHeaders(cookie), origin: 'https://evil.example' },
    body,
  })
  expect(crossSite.status).toBe(403)
})

test('denying redirects with access_denied and the state', async () => {
  const res = await fetch(`${app.base}/api/devices/pairing/deny`, {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({ request: Object.fromEntries(new URLSearchParams(connectQuery({ state: 'st' }))) }),
  })
  expect(await res.json()).toEqual({ redirectTo: 'hobwork://paired?error=access_denied&state=st' })
})

test('device names are slugs of the name the app sends', () => {
  expect(slugifyDeviceName("Kaan's iPhone")).toBe('kaans-iphone')
  expect(slugifyDeviceName('  Ümit’s MacBook Pro (2024) ')).toBe('umits-macbook-pro-2024')
  expect(slugifyDeviceName('📱')).toBe('device')
})

test('web-session gives a one-time URL that signs the web view in as the owner', async () => {
  const device = await pairDevice(app.base, cookie)
  const webSession = (body: unknown, token = device.token) =>
    fetch(`${app.base}/api/devices/web-session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  expect((await webSession({ returnTo: '/' }, 'hwd_wrong')).status).toBe(401)
  // A session cookie is not a device token.
  const withCookie = await fetch(`${app.base}/api/devices/web-session`, {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({ returnTo: '/' }),
  })
  expect(withCookie.status).toBe(401)
  for (const returnTo of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'projects']) {
    expect((await webSession({ returnTo })).status, returnTo).toBe(400)
  }

  const res = await webSession({ returnTo: '/auth/app?project=filament&returnTo=x' })
  expect(res.status).toBe(200)
  const { url } = (await res.json()) as { url: string }
  expect(url.startsWith(`${TEST_PUBLIC_URL}/auth/device?token=`)).toBe(true)

  const path = url.slice(TEST_PUBLIC_URL.length)
  const open = await fetch(`${app.base}${path}`, { redirect: 'manual' })
  expect(open.status).toBe(303)
  expect(open.headers.get('location')).toBe('/auth/app?project=filament&returnTo=x')
  const sessionCookie = /hobwork_session=([^;]+)/.exec(open.headers.get('set-cookie') ?? '')?.[1]
  expect(findSession(host.db, decodeURIComponent(sessionCookie!))?.id).toBe(userId)

  const again = await fetch(`${app.base}${path}`, { redirect: 'manual' })
  expect(again.headers.get('location')).toBe('/login?error=link_expired')
  expect(again.headers.get('set-cookie')).toBeNull()
})

test("the web view's session ends when the device is removed, and a new sign-in replaces it", async () => {
  const device = await pairDevice(app.base, cookie)
  const signIn = async () => {
    const res = await fetch(`${app.base}/api/devices/web-session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: '/' }),
    })
    const { url } = (await res.json()) as { url: string }
    const open = await fetch(`${app.base}${url.slice(TEST_PUBLIC_URL.length)}`, { redirect: 'manual', headers: { 'sec-fetch-site': 'none' } })
    return `hobwork_session=${/hobwork_session=([^;]+)/.exec(open.headers.get('set-cookie') ?? '')![1]}`
  }
  const who = async (sessionCookie: string) =>
    ((await (await fetch(`${app.base}/api/session`, { headers: { cookie: sessionCookie } })).json()) as { user: unknown }).user

  const first = await signIn()
  const second = await signIn()
  expect(await who(first)).toBeNull()
  expect(await who(second)).toMatchObject({ name: 'Kaan' })
  const project = await createProject(host, 'filament')
  appSessionCookie(host, second, 'filament')

  await fetch(`${app.base}/api/devices/${device.deviceId}/revoke`, { method: 'POST', headers: writeHeaders(cookie) })
  expect(await who(second)).toBeNull()
  expect(host.db.prepare('SELECT count(*) AS n FROM app_sessions WHERE project_id = ?').get(project.id)).toEqual({ n: 0 })
  // The person's own browser session is untouched.
  expect(await who(cookie)).toMatchObject({ name: 'Kaan' })
})

test('the sign-in link only works when the app opens it, not from another page', async () => {
  const device = await pairDevice(app.base, cookie)
  const link = createWebSessionLink(host.db, TEST_PUBLIC_URL, device.deviceId, '/').slice(TEST_PUBLIC_URL.length)
  for (const site of ['cross-site', 'same-site', 'same-origin']) {
    const res = await fetch(`${app.base}${link}`, { redirect: 'manual', headers: { 'sec-fetch-site': site } })
    expect(res.status, site).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
  }
  // Refused requests did not use the link up.
  const ok = await fetch(`${app.base}${link}`, { redirect: 'manual', headers: { 'sec-fetch-site': 'none' } })
  expect(ok.status).toBe(303)
  expect(ok.headers.get('set-cookie')).toMatch(/hobwork_session=/)
})

test('web-session links expire after 60 seconds and die with their device', async () => {
  const device = await pairDevice(app.base, cookie)
  const start = Date.now()
  const token = (url: string) => new URL(url).searchParams.get('token')!
  const expired = token(createWebSessionLink(host.db, TEST_PUBLIC_URL, device.deviceId, '/', start))
  expect(redeemWebSessionLink(host.db, expired, start + WEB_SESSION_LINK_TTL_MS + 1)).toBeUndefined()

  const link = token(createWebSessionLink(host.db, TEST_PUBLIC_URL, device.deviceId, '/'))
  const revoke = await fetch(`${app.base}/api/devices/${device.deviceId}/revoke`, { method: 'POST', headers: writeHeaders(cookie) })
  expect(revoke.status).toBe(204)
  expect(redeemWebSessionLink(host.db, link)).toBeUndefined()
})

test('the app updates its push grant while disconnected', async () => {
  const device = await pairDevice(app.base, cookie)
  const put = (body: unknown) =>
    fetch(`${app.base}/api/devices/push`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const push = { grant: 'R3JhbnQtZm9yLXRoZS1hcHA', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  expect((await put(push)).status).toBe(204)
  expect(verifyDeviceToken(host.db, device.token)?.push).toEqual(push)
  expect((await put({ grant: 'not a grant', key: push.key })).status).toBe(400)
  expect((await put({ grant: push.grant, key: 'too short' })).status).toBe(400)
  // What older apps sent: an APNs token.
  expect((await put({ token: 'abcdef0123456789abcdef', environment: 'sandbox' })).status).toBe(400)
  expect((await put({ grant: null })).status).toBe(204)
  expect(verifyDeviceToken(host.db, device.token)?.push).toBeNull()
})

test('a push grant belongs to one device, and removing the device forgets it', async () => {
  const old = await pairDevice(app.base, cookie, { name: 'old-phone' })
  const paired = await pairDevice(app.base, cookie)
  const push = { grant: 'R3JhbnQtZm9yLXRoZS1hcHA', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  setPush(host.db, old.deviceId, push)
  setPush(host.db, paired.deviceId, push)
  expect(getDevice(host.db, old.deviceId)?.push).toBeNull()
  expect(getDevice(host.db, paired.deviceId)?.push).toEqual(push)

  await fetch(`${app.base}/api/devices/${paired.deviceId}/revoke`, { method: 'POST', headers: writeHeaders(cookie) })
  expect(host.db.prepare('SELECT push_grant, push_key FROM devices WHERE id = ?').get(paired.deviceId)).toEqual({ push_grant: null, push_key: null })
})

test('pairing codes only take known platforms', () => {
  expect(() => createPairingCode(host.db, { userId, name: 'x', platform: 'android' as 'ios', codeChallenge: pkce().challenge })).toThrow(
    /CHECK constraint/,
  )
})

test('people list, rename and revoke devices; a revoked token stops working', async () => {
  const device = await pairDevice(app.base, cookie)
  const list = async () => ((await (await fetch(`${app.base}/api/devices`, { headers: { cookie } })).json()) as { devices: { name: string }[]; push: boolean })
  expect(await list()).toMatchObject({
    push: false,
    devices: [{ id: device.deviceId, name: 'kaan-iphone', owner: 'Kaan', platform: 'ios', connected: false, capabilities: [] }],
  })

  const rename = (name: string) =>
    fetch(`${app.base}/api/devices/${device.deviceId}`, { method: 'PATCH', headers: writeHeaders(cookie), body: JSON.stringify({ name }) })
  expect((await rename('Kaan Phone')).status).toBe(400)
  const renamed = await rename('kaan-phone')
  expect(renamed.status).toBe(200)
  expect(await renamed.json()).toMatchObject({ name: 'kaan-phone' })

  await fetch(`${app.base}/api/devices/${device.deviceId}/revoke`, { method: 'POST', headers: writeHeaders(cookie) })
  expect((await list()).devices).toEqual([])
  expect(verifyDeviceToken(host.db, device.token)).toBeUndefined()
  const push = await fetch(`${app.base}/api/devices/push`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token: null }),
  })
  expect(push.status).toBe(401)
  // The name is free again.
  expect((await pairDevice(app.base, cookie, { name: 'kaan-phone' })).name).toBe('kaan-phone')
})

test('agent tokens cannot manage devices', async () => {
  const res = await fetch(`${app.base}/api/devices`, { headers: { authorization: 'Bearer hw_anything' } })
  expect(res.status).toBe(401)
})
