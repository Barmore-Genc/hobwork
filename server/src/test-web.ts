import { createServer, type AddressInfo } from 'node:net'
import { CSRF_HEADER } from './auth/auth.ts'
import { createSession } from './auth/sessions.ts'
import { signInOidcUser, type User } from './auth/users.ts'
import { createApp, type WebOptions } from './app.ts'
import type { Delivery } from './delivery.ts'
import type { Host } from './host.ts'
import type { SecretStore } from './secrets.ts'

export const TEST_PUBLIC_URL = 'http://hobwork.test'

export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

// With selfPublicUrl, the public URL is the address the app listens on, so
// URLs in OAuth metadata and redirects work from the test.
export async function startTestApp(
  host: Host,
  options: { web?: Partial<WebOptions>; delivery?: Delivery; selfPublicUrl?: boolean; secrets?: SecretStore } = {},
) {
  const port = options.selfPublicUrl ? await freePort() : 0
  const server = createApp(host, {
    delivery: options.delivery,
    secrets: options.secrets,
    web: {
      publicUrl: options.selfPublicUrl ? `http://127.0.0.1:${port}` : TEST_PUBLIC_URL,
      allowlist: { emails: ['kaan@example.com'], subjects: [] },
      ...options.web,
    },
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
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
export function writeHeaders(cookie: string, origin = TEST_PUBLIC_URL): Record<string, string> {
  return {
    cookie,
    [CSRF_HEADER]: '1',
    origin,
    'content-type': 'application/json',
  }
}
