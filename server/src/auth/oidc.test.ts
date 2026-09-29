import { afterEach, beforeEach, expect, test } from 'vitest'
import { createTestHost } from '../test-host.ts'
import { startTestApp, TEST_PUBLIC_URL } from '../test-web.ts'
import { startFakeOidcProvider, type FakeOidcProvider } from './fake-oidc.ts'
import { identityFromClaims, safeReturnTo } from './oidc.ts'

let host: ReturnType<typeof createTestHost>
let provider: FakeOidcProvider
let app: Awaited<ReturnType<typeof startTestApp>>

const client = { id: 'hobwork', secret: 'test-secret' }
const kaan = { sub: 'sub-kaan', name: 'Kaan', email: 'kaan@example.com', email_verified: true }

beforeEach(async () => {
  host = createTestHost()
  provider = await startFakeOidcProvider(client)
  app = await startTestApp(host, {
    web: {
      oidc: { issuer: provider.issuer, clientId: client.id, clientSecret: client.secret, name: 'Pocket ID' },
    },
  })
})

afterEach(async () => {
  await app.close()
  await provider.close()
  host.dispose()
})

function cookies(res: Response): Map<string, string> {
  return new Map(
    res.headers.getSetCookie().map((c) => {
      const pair = c.split(';')[0]!
      return [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]
    }),
  )
}

async function startLogin(returnTo = '/projects/filament') {
  const res = await fetch(`${app.base}/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual' })
  expect(res.status).toBe(303)
  const flow = cookies(res).get('hobwork_oidc')
  expect(flow).toBeTruthy()
  return { authorizationUrl: res.headers.get('location')!, flowCookie: `hobwork_oidc=${flow}` }
}

async function finish(callbackUrl: string, flowCookie?: string) {
  const url = new URL(callbackUrl)
  expect(url.origin).toBe(TEST_PUBLIC_URL)
  return fetch(`${app.base}${url.pathname}${url.search}`, {
    redirect: 'manual',
    headers: flowCookie ? { cookie: flowCookie } : {},
  })
}

async function session(cookie: string) {
  return (await fetch(`${app.base}/api/session`, { headers: { cookie } })).json()
}

test('session endpoint reports the sign-in method when signed out', async () => {
  expect(await session('')).toEqual({ user: null, signIn: { oidc: { name: 'Pocket ID' } } })
})

test('authorization code flow with PKCE signs the user in', async () => {
  const { authorizationUrl, flowCookie } = await startLogin()
  const params = new URL(authorizationUrl).searchParams
  expect(params.get('redirect_uri')).toBe(`${TEST_PUBLIC_URL}/auth/callback`)
  expect(params.get('scope')).toBe('openid profile email')
  expect(params.get('client_id')).toBe('hobwork')

  const res = await finish(provider.approve(authorizationUrl, kaan), flowCookie)
  expect(res.status).toBe(303)
  expect(res.headers.get('location')).toBe('/projects/filament')
  const set = res.headers.getSetCookie()
  expect(set.find((c) => c.startsWith('hobwork_session='))).toMatch(/HttpOnly; SameSite=Lax/)
  expect(set.find((c) => c.startsWith('hobwork_oidc='))).toMatch(/Max-Age=0/)
  expect(provider.tokenRequests[0]?.get('code_verifier')).toBeTruthy()

  const cookie = `hobwork_session=${cookies(res).get('hobwork_session')}`
  expect(await session(cookie)).toMatchObject({ user: { name: 'Kaan', email: 'kaan@example.com' } })
})

test('profile claims missing from the ID token come from userinfo', async () => {
  provider.omitIdTokenProfile = true
  const { authorizationUrl, flowCookie } = await startLogin()
  const res = await finish(provider.approve(authorizationUrl, kaan), flowCookie)
  expect(res.headers.get('location')).toBe('/projects/filament')
  const cookie = `hobwork_session=${cookies(res).get('hobwork_session')}`
  expect(await session(cookie)).toMatchObject({ user: { name: 'Kaan', email: 'kaan@example.com' } })
})

test('users not on the allowlist are refused', async () => {
  const { authorizationUrl, flowCookie } = await startLogin()
  const res = await finish(
    provider.approve(authorizationUrl, { ...kaan, sub: 'sub-guest', email: 'guest@example.com' }),
    flowCookie,
  )
  expect(res.headers.get('location')).toBe('/login?error=not_allowed')
  expect(cookies(res).has('hobwork_session')).toBe(false)
  expect(host.db.prepare('SELECT count(*) AS n FROM users').get()?.n).toBe(0)
})

test('an unverified email does not match the allowlist', async () => {
  const { authorizationUrl, flowCookie } = await startLogin()
  const res = await finish(provider.approve(authorizationUrl, { ...kaan, email_verified: false }), flowCookie)
  expect(res.headers.get('location')).toBe('/login?error=not_allowed')
})

test('callback without the flow cookie or with a wrong state fails', async () => {
  const { authorizationUrl, flowCookie } = await startLogin()
  const callback = provider.approve(authorizationUrl, kaan)
  expect((await finish(callback)).headers.get('location')).toBe('/login?error=expired')

  const tampered = new URL(callback)
  tampered.searchParams.set('state', 'forged')
  expect((await finish(tampered.href, flowCookie)).headers.get('location')).toBe('/login?error=failed')
})

test('a flow cookie from another login attempt fails the PKCE and state checks', async () => {
  const first = await startLogin()
  const second = await startLogin()
  const res = await finish(provider.approve(first.authorizationUrl, kaan), second.flowCookie)
  expect(res.headers.get('location')).toBe('/login?error=failed')
})

test('sign-out deletes the session and needs the CSRF header', async () => {
  const { authorizationUrl, flowCookie } = await startLogin()
  const res = await finish(provider.approve(authorizationUrl, kaan), flowCookie)
  const cookie = `hobwork_session=${cookies(res).get('hobwork_session')}`

  expect((await fetch(`${app.base}/auth/logout`, { method: 'POST', headers: { cookie } })).status).toBe(403)
  const out = await fetch(`${app.base}/auth/logout`, {
    method: 'POST',
    headers: { cookie, 'x-hobwork-csrf': '1', origin: TEST_PUBLIC_URL },
  })
  expect(out.status).toBe(204)
  expect(out.headers.getSetCookie()[0]).toMatch(/^hobwork_session=; .*Max-Age=0/)
  expect(await session(cookie)).toMatchObject({ user: null })
})

test('return paths stay on this site', () => {
  expect(safeReturnTo('/agents')).toBe('/agents')
  expect(safeReturnTo('//evil.example.com')).toBe('/')
  expect(safeReturnTo('/\\evil.example.com')).toBe('/')
  expect(safeReturnTo('https://evil.example.com')).toBe('/')
  expect(safeReturnTo(null)).toBe('/')
})

test('identity from claims', () => {
  expect(identityFromClaims('i', { sub: 's', given_name: 'Ada', family_name: 'L', email: 'a@x', email_verified: true }))
    .toEqual({ issuer: 'i', subject: 's', name: 'Ada L', email: 'a@x' })
  expect(identityFromClaims('i', { sub: 's', preferred_username: 'ada', email: 'a@x' })).toEqual({
    issuer: 'i',
    subject: 's',
    name: 'ada',
    email: null,
  })
  expect(() => identityFromClaims('i', {})).toThrow('subject')
})
