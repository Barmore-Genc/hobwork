import { afterEach, beforeEach, expect, test } from 'vitest'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, TEST_PUBLIC_URL, writeHeaders } from '../test-web.ts'
import { createSignInLink } from './links.ts'
import { SoftwareAuthenticator } from './test-authenticator.ts'
import { findOrCreateEmailUser, signInOidcUser } from './users.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string

const allowlist = { emails: ['kaan@example.com', 'guest@example.com'], subjects: [] }

beforeEach(async () => {
  host = createTestHost()
  app = await startTestApp(host, { web: { allowlist } })
  cookie = signedIn(host).cookie
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

async function jsonOf(res: Response): Promise<any> {
  return res.json()
}

function post(path: string, body: unknown, headers: Record<string, string> = writeHeaders(cookie)) {
  return fetch(`${app.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

const signedOutHeaders = () => {
  const { cookie: _, ...headers } = writeHeaders('')
  return headers
}

async function addPasskey(
  authenticator: SoftwareAuthenticator,
  name: string | null = 'Laptop',
  headers = writeHeaders(cookie),
  device?: string,
) {
  const { flowId, options } = await jsonOf(await post('/api/passkeys/options', {}, headers))
  return post('/api/passkeys', { flowId, name, device, response: authenticator.register(options) }, headers)
}

async function signInWith(authenticator: SoftwareAuthenticator) {
  const { flowId, options } = await jsonOf(await post('/auth/passkey/options', {}, signedOutHeaders()))
  expect(options.allowCredentials ?? []).toEqual([])
  expect(options.userVerification).toBe('required')
  return post('/auth/passkey', { flowId, response: authenticator.authenticate(options) }, signedOutHeaders())
}

function sessionCookie(res: Response): string {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('hobwork_session='))
  expect(header).toBeDefined()
  return header!.split(';')[0]!
}

test('a signed-in user adds a passkey and signs in with it later', async () => {
  const authenticator = new SoftwareAuthenticator(TEST_PUBLIC_URL)
  const added = await addPasskey(authenticator)
  expect(added.status).toBe(201)
  expect(await jsonOf(added)).toMatchObject({ name: 'Laptop', lastUsedAt: null })

  const { options } = await jsonOf(await post('/api/passkeys/options', {}))
  expect(options.rp).toEqual({ name: 'Hobwork', id: 'hobwork.test' })
  expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })
  expect(options.excludeCredentials).toMatchObject([{ id: authenticator.credentialId.toString('base64url') }])

  const res = await signInWith(authenticator)
  expect(res.status).toBe(200)
  expect(await jsonOf(res)).toEqual({ user: { name: 'Kaan', email: 'kaan@example.com' } })
  const session = await jsonOf(await fetch(`${app.base}/api/session`, { headers: { cookie: sessionCookie(res) } }))
  expect(session).toMatchObject({ user: { name: 'Kaan' }, signIn: { passkey: true } })

  const listed = await jsonOf(await fetch(`${app.base}/api/passkeys`, { headers: { cookie } }))
  expect(listed).toHaveLength(1)
  expect(listed[0].lastUsedAt).not.toBeNull()
})

test('adding and listing passkeys needs a session', async () => {
  expect((await fetch(`${app.base}/api/passkeys`)).status).toBe(401)
  expect((await post('/api/passkeys/options', {}, signedOutHeaders())).status).toBe(401)
  expect((await post('/api/passkeys/options', {}, { cookie, 'content-type': 'application/json' })).status).toBe(403)
  expect((await post('/auth/passkey/options', {}, { 'content-type': 'application/json' })).status).toBe(403)
})

test('each challenge works once and responses must match the site', async () => {
  const authenticator = new SoftwareAuthenticator(TEST_PUBLIC_URL)
  expect((await addPasskey(authenticator)).status).toBe(201)

  const { flowId, options } = await jsonOf(await post('/auth/passkey/options', {}, signedOutHeaders()))
  const response = authenticator.authenticate(options)
  expect((await post('/auth/passkey', { flowId, response }, signedOutHeaders())).status).toBe(200)
  const replay = await post('/auth/passkey', { flowId, response }, signedOutHeaders())
  expect(replay.status).toBe(400)

  const phishing = new SoftwareAuthenticator('https://hobwork.evil.example')
  phishing.credentialId = authenticator.credentialId
  phishing.privateKey = authenticator.privateKey
  phishing.userHandle = authenticator.userHandle
  const fresh = await jsonOf(await post('/auth/passkey/options', {}, signedOutHeaders()))
  const refused = await post('/auth/passkey', { flowId: fresh.flowId, response: phishing.authenticate(fresh.options) }, signedOutHeaders())
  expect(refused.status).toBe(401)
  expect(refused.headers.getSetCookie()).toEqual([])
})

test('unknown passkeys and people removed from the allowlist cannot sign in', async () => {
  const stranger = new SoftwareAuthenticator(TEST_PUBLIC_URL)
  stranger.userHandle = 'x'
  expect((await signInWith(stranger)).status).toBe(401)

  const authenticator = new SoftwareAuthenticator(TEST_PUBLIC_URL)
  expect((await addPasskey(authenticator)).status).toBe(201)
  await app.close()
  app = await startTestApp(host, { web: { allowlist: { emails: [], subjects: [] } } })
  const res = await signInWith(authenticator)
  expect(res.status).toBe(403)
  expect(res.headers.getSetCookie()).toEqual([])
})

test('users remove only their own passkeys', async () => {
  const authenticator = new SoftwareAuthenticator(TEST_PUBLIC_URL)
  const { id } = await jsonOf(await addPasskey(authenticator))
  const guest = signedIn(host, 'guest@example.com').cookie
  const remove = (who: string) => fetch(`${app.base}/api/passkeys/${id}`, { method: 'DELETE', headers: writeHeaders(who) })
  expect((await remove(guest)).status).toBe(404)
  expect((await remove(cookie)).status).toBe(204)
  expect(await jsonOf(await fetch(`${app.base}/api/passkeys`, { headers: { cookie } }))).toEqual([])
  expect((await signInWith(authenticator)).status).toBe(401)
})

test('new passkeys without a name are named after their password manager or the device', async () => {
  const apple = new SoftwareAuthenticator(TEST_PUBLIC_URL, 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd')
  expect(await jsonOf(await addPasskey(apple, '', undefined, 'Mac'))).toMatchObject({ name: 'Apple Passwords' })
  const unknown = new SoftwareAuthenticator(TEST_PUBLIC_URL)
  expect(await jsonOf(await addPasskey(unknown, null, undefined, 'Windows'))).toMatchObject({ name: 'Windows' })
  const bare = new SoftwareAuthenticator(TEST_PUBLIC_URL)
  expect(await jsonOf(await addPasskey(bare, '  '))).toMatchObject({ name: 'Passkey' })
})

test('users rename only their own passkeys', async () => {
  const { id } = await jsonOf(await addPasskey(new SoftwareAuthenticator(TEST_PUBLIC_URL)))
  const guest = signedIn(host, 'guest@example.com').cookie
  const rename = (who: string, name: unknown) =>
    fetch(`${app.base}/api/passkeys/${id}`, { method: 'PATCH', headers: writeHeaders(who), body: JSON.stringify({ name }) })

  expect((await rename(guest, 'Mine now')).status).toBe(404)
  expect((await rename(cookie, '   ')).status).toBe(400)
  expect((await rename(cookie, 'x'.repeat(65))).status).toBe(400)
  const renamed = await rename(cookie, '  Work laptop ')
  expect(renamed.status).toBe(200)
  expect(await jsonOf(renamed)).toMatchObject({ id, name: 'Work laptop' })
  expect(await jsonOf(await fetch(`${app.base}/api/passkeys`, { headers: { cookie } }))).toMatchObject([{ name: 'Work laptop' }])

  const { cookie: _, ...noCookie } = writeHeaders('')
  expect(
    (await fetch(`${app.base}/api/passkeys/${id}`, { method: 'PATCH', headers: noCookie, body: '{"name":"x"}' })).status,
  ).toBe(401)
})

test('a sign-in link lets someone without an identity provider enroll a passkey', async () => {
  expect(findOrCreateEmailUser(host.db, allowlist, 'someone@example.com')).toBeUndefined()
  const user = findOrCreateEmailUser(host.db, allowlist, 'Guest@example.com', 'Guest')!
  expect(user).toMatchObject({ name: 'Guest', email: 'Guest@example.com' })
  const link = new URL(createSignInLink(host.db, TEST_PUBLIC_URL, user.id))
  const path = `${link.pathname}${link.search}`

  const res = await fetch(`${app.base}${path}`, { redirect: 'manual' })
  expect(res.status).toBe(303)
  expect(res.headers.get('location')).toBe('/settings')
  const guestCookie = sessionCookie(res)
  const authenticator = new SoftwareAuthenticator(TEST_PUBLIC_URL)
  expect((await addPasskey(authenticator, 'Phone', writeHeaders(guestCookie))).status).toBe(201)
  expect(await jsonOf(await signInWith(authenticator))).toEqual({ user: { name: 'Guest', email: 'Guest@example.com' } })

  const again = await fetch(`${app.base}${path}`, { redirect: 'manual' })
  expect(again.headers.get('location')).toBe('/login?error=link_expired')

  // Signing in with an identity provider later joins the same user.
  const oidcUser = signInOidcUser(host.db, allowlist, {
    issuer: 'https://id.example.com',
    subject: 'guest-sub',
    name: 'Guest G',
    email: 'guest@example.com',
  })
  expect(oidcUser?.id).toBe(user.id)
})
