import type { AddressInfo } from 'node:net'
import { CSRF_HEADER } from './auth/auth.ts'
import { createSession } from './auth/sessions.ts'
import { signInOidcUser, type User } from './auth/users.ts'
import { createApp, type WebOptions } from './app.ts'
import type { Delivery } from './delivery.ts'
import type { Host } from './host.ts'

export const TEST_PUBLIC_URL = 'http://hobwork.test'

export async function startTestApp(host: Host, options: { web?: Partial<WebOptions>; delivery?: Delivery } = {}) {
  const server = createApp(host, {
    delivery: options.delivery,
    web: {
      publicUrl: TEST_PUBLIC_URL,
      allowlist: { emails: ['kaan@example.com'], subjects: [] },
      ...options.web,
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// Signs in a user on the default test allowlist and returns their cookie header.
export function signedIn(host: Host, email = 'kaan@example.com'): { user: User; cookie: string } {
  const user = signInOidcUser(
    host.db,
    { emails: [email], subjects: [] },
    { issuer: 'https://id.example.com', subject: `sub-${email}`, name: 'Kaan', email },
  )
  if (!user) throw new Error('Test user was not allowed')
  return { user, cookie: `hobwork_session=${createSession(host.db, user.id)}` }
}

// Headers the web UI sends with state-changing requests.
export function writeHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    [CSRF_HEADER]: '1',
    origin: TEST_PUBLIC_URL,
    'content-type': 'application/json',
  }
}
