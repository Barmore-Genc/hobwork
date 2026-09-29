import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import type { Backups } from './backup/backups.ts'
import { createAppCode, redeemAppCode } from './apps/sessions.ts'
import { CSRF_HEADER } from './auth/auth.ts'
import { createSession, findSessionRecord } from './auth/sessions.ts'
import { signInOidcUser, type User } from './auth/users.ts'
import { createApp, type WebOptions } from './app.ts'
import type { ProjectData } from './data/project-data.ts'
import type { Delivery } from './delivery.ts'
import type { HomeAssistant } from './homeassistant/client.ts'
import type { HomeAssistantSettings } from './homeassistant/settings.ts'
import type { Host } from './host.ts'
import { requireProject } from './projects.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { SecretStore } from './secrets.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from './workspaces.ts'

export const TEST_PUBLIC_URL = 'http://hobwork.test'
export const TEST_APPS_DOMAIN = 'apps.hobwork.test'

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
  options: {
    web?: Partial<WebOptions>
    delivery?: Delivery
    selfPublicUrl?: boolean
    secrets?: SecretStore
    runtime?: Runtime
    data?: ProjectData
    backups?: Backups
    workspaces?: WorkspaceManager<ExecWorkspaceVm>
    homeAssistant?: HomeAssistant
    homeAssistantSettings?: HomeAssistantSettings
  } = {},
) {
  const port = options.selfPublicUrl ? await freePort() : 0
  const server = createApp(host, {
    delivery: options.delivery,
    workspaces: options.workspaces,
    homeAssistant: options.homeAssistant,
    homeAssistantSettings: options.homeAssistantSettings,
    secrets: options.secrets,
    runtime: options.runtime,
    data: options.data,
    backups: options.backups,
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

// A session cookie for a project's app origin, the way the sign-in redirects
// would set it, for a user signed in with `cookie`.
export function appSessionCookie(host: Host, cookie: string, project: string, branch?: string): string {
  const session = findSessionRecord(host.db, cookie.split('=')[1]!)
  if (!session) throw new Error('No Hobwork session for this cookie')
  const scope = { projectId: requireProject(host, project).id, branch: branch ?? null }
  const redeemed = redeemAppCode(host.db, createAppCode(host.db, session.id, scope), scope)
  if (!redeemed) throw new Error('Could not redeem the app code')
  return `hobwork_app=${redeemed.token}`
}

export type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string }

// fetch() cannot set the Host header, which is how the host tells app origins
// apart. Sends `url` to the test server at `base` with the URL's host as Host.
export function sendTo(
  base: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const target = new URL(url)
  const server = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: server.hostname,
        port: server.port,
        method: init.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers: { host: target.host, ...init.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(init.body)
  })
}
