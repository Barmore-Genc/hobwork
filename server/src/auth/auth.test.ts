import type { IncomingMessage } from 'node:http'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createTestHost } from '../test-host.ts'
import { createAuth, CSRF_HEADER } from './auth.ts'
import { createSession, deleteSession, findSession, SESSION_TTL_SECONDS } from './sessions.ts'
import { isAllowed, signInOidcUser } from './users.ts'

let host: ReturnType<typeof createTestHost>

beforeEach(() => {
  host = createTestHost()
})

afterEach(() => host.dispose())

const allowlist = { emails: ['kaan@example.com'], subjects: ['sub-guest'] }
const kaan = { issuer: 'https://id.example.com', subject: 'sub-kaan', name: 'Kaan', email: 'Kaan@Example.com' }

function request(headers: Record<string, string>, method = 'GET'): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage
}

test('sign-in creates a user once per identity and follows profile changes', () => {
  const first = signInOidcUser(host.db, allowlist, kaan)
  const again = signInOidcUser(host.db, allowlist, { ...kaan, name: 'Kaan B' })
  expect(again).toEqual({ id: first?.id, name: 'Kaan B', email: 'Kaan@Example.com' })
  expect(host.db.prepare('SELECT count(*) AS n FROM users').get()?.n).toBe(1)
})

test('sign-in needs a verified email or subject on the allowlist', () => {
  expect(signInOidcUser(host.db, allowlist, { ...kaan, email: null })).toBeUndefined()
  expect(signInOidcUser(host.db, allowlist, { ...kaan, email: 'someone@example.com' })).toBeUndefined()
  expect(signInOidcUser(host.db, allowlist, { ...kaan, subject: 'sub-guest', email: null })).toBeDefined()
  expect(host.db.prepare('SELECT count(*) AS n FROM users').get()?.n).toBe(1)
})

test('sessions expire and can be deleted', () => {
  const user = signInOidcUser(host.db, allowlist, kaan)!
  const now = Date.now()
  const token = createSession(host.db, user.id, now)
  expect(findSession(host.db, token, now)).toEqual(user)
  expect(findSession(host.db, token, now + SESSION_TTL_SECONDS * 1000 + 1)).toBeUndefined()
  expect(findSession(host.db, 'not-a-token', now)).toBeUndefined()
  deleteSession(host.db, token)
  expect(findSession(host.db, token, now)).toBeUndefined()
})

test('session tokens are stored hashed', () => {
  const user = signInOidcUser(host.db, allowlist, kaan)!
  const token = createSession(host.db, user.id)
  const stored = host.db.prepare('SELECT token_hash FROM sessions').get()?.token_hash
  expect(stored).not.toContain(token)
})

test('removing someone from the allowlist ends their sessions', () => {
  const user = signInOidcUser(host.db, allowlist, kaan)!
  const token = createSession(host.db, user.id)
  const cookie = `hobwork_session=${token}`
  expect(createAuth({ db: host.db, publicUrl: 'http://localhost:7420', allowlist }).currentUser(request({ cookie })))
    .toEqual(user)
  const without = { emails: [], subjects: [] }
  expect(isAllowed(host.db, without, user)).toBe(false)
  expect(
    createAuth({ db: host.db, publicUrl: 'http://localhost:7420', allowlist: without }).currentUser(request({ cookie })),
  ).toBeUndefined()
})

test('subjects on the allowlist match any identity of the user', () => {
  const user = signInOidcUser(host.db, allowlist, { ...kaan, subject: 'sub-guest', email: null })!
  expect(isAllowed(host.db, { emails: [], subjects: ['sub-guest'] }, user)).toBe(true)
  expect(isAllowed(host.db, { emails: [], subjects: ['other'] }, user)).toBe(false)
  expect(isAllowed(host.db, { emails: [], subjects: [], everyone: true }, user)).toBe(true)
})

test('with everyone allowed, any identity from the provider signs in', () => {
  const everyone = { emails: [], subjects: [], everyone: true }
  const user = signInOidcUser(host.db, everyone, { ...kaan, subject: 'sub-new', email: 'new@example.com' })
  expect(user?.email).toBe('new@example.com')
})

test('cookie is __Host- prefixed and Secure behind https', () => {
  expect(createAuth({ db: host.db, publicUrl: 'https://hob.example.com', allowlist })).toMatchObject({
    cookieName: '__Host-hobwork_session',
    secure: true,
  })
  expect(createAuth({ db: host.db, publicUrl: 'http://localhost:7420', allowlist })).toMatchObject({
    cookieName: 'hobwork_session',
    secure: false,
  })
})

test('CSRF check on state-changing requests', () => {
  const auth = createAuth({ db: host.db, publicUrl: 'https://hob.example.com', allowlist })
  const res = () => {
    const r = { status: 0, writeHead: (s: number) => ((r.status = s), r), end: () => r }
    return r
  }
  const check = (headers: Record<string, string>, method = 'POST') => {
    const r = res()
    return auth.checkCsrf(request(headers, method), r as never) ? 'ok' : r.status
  }
  expect(check({}, 'GET')).toBe('ok')
  expect(check({})).toBe(403)
  expect(check({ [CSRF_HEADER]: '1' })).toBe('ok')
  expect(check({ [CSRF_HEADER]: '1', origin: 'https://hob.example.com', 'sec-fetch-site': 'same-origin' })).toBe('ok')
  expect(check({ [CSRF_HEADER]: '1', origin: 'https://evil.example.com' })).toBe(403)
  expect(check({ [CSRF_HEADER]: '1', 'sec-fetch-site': 'cross-site' })).toBe(403)
  expect(check({ [CSRF_HEADER]: '1', 'sec-fetch-site': 'same-site' })).toBe(403)
})

test('one identity per issuer: another subject with the same email is refused', () => {
  const first = signInOidcUser(host.db, allowlist, kaan)!
  const other = signInOidcUser(host.db, allowlist, { ...kaan, subject: 'sub-impostor' })
  expect(other).toBeUndefined()
  expect(host.db.prepare('SELECT count(*) AS n FROM users').get()?.n).toBe(1)
  expect(host.db.prepare('SELECT count(*) AS n FROM user_identities').get()?.n).toBe(1)
  expect(signInOidcUser(host.db, allowlist, kaan)?.id).toBe(first.id)
})

test('an issuer that has not been linked yet can still join a user by verified email', () => {
  const first = signInOidcUser(host.db, allowlist, kaan)!
  const second = signInOidcUser(host.db, allowlist, { ...kaan, issuer: 'https://other.example.com', subject: 'other-sub' })
  expect(second?.id).toBe(first.id)
})
