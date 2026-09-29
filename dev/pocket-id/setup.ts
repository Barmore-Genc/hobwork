// Usage: node dev/pocket-id/setup.ts [up|login-link|down|reset]
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const compose = join(dir, 'compose.yaml')
const envFile = join(dir, '.env.local')
const dataDir = join(dir, 'data')

// Must match compose.yaml.
const ISSUER = 'http://localhost:11411'
const STATIC_API_KEY = 'hobwork-dev-static-api-key'

const CLIENT_ID = 'hobwork-dev'
const CLIENT_SECRET = 'hobwork-dev-client-secret'
// Vite dev server first (pnpm dev), then a host serving the built UI. Hobwork
// runs on hobwork.localhost so project apps on *.apps.hobwork.localhost are
// the same site and can sign in inside its iframe.
const CALLBACK_URLS = [
  'http://hobwork.localhost:5173/auth/callback',
  'http://hobwork.localhost:7420/auth/callback',
  'http://localhost:5173/auth/callback',
  'http://localhost:7420/auth/callback',
]
const USER = {
  username: 'household',
  email: 'household@hobwork.test',
  emailVerified: true,
  firstName: 'Robin',
  lastName: 'Hob',
  displayName: 'Robin Hob',
  isAdmin: true,
}

function docker(...args: string[]) {
  execFileSync('docker', ['compose', '-f', compose, ...args], { stdio: 'inherit' })
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${ISSUER}/api${path}`, {
    method,
    headers: { 'x-api-key': STATIC_API_KEY, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function apiJson<T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await api(method, path, body)
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function waitForPocketId() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${ISSUER}/.well-known/openid-configuration`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Pocket ID did not come up within a minute')
}

async function ensureUser(): Promise<string> {
  const { data } = await apiJson<{ data: { id: string; username: string }[] }>(
    'GET',
    `/users?search=${encodeURIComponent(USER.username)}`,
  )
  const existing = data.find((u) => u.username === USER.username)
  if (existing) return existing.id
  return (await apiJson('POST', '/users', USER)).id
}

async function ensureClient() {
  const client = {
    name: 'Hobwork (dev)',
    callbackURLs: CALLBACK_URLS,
    logoutCallbackURLs: [],
    isPublic: false,
    pkceEnabled: true,
    skipConsent: true,
  }
  const existing = await api('GET', `/oidc/clients/${CLIENT_ID}`)
  if (existing.ok) await apiJson('PUT', `/oidc/clients/${CLIENT_ID}`, client)
  else await apiJson('POST', '/oidc/clients', { id: CLIENT_ID, ...client })

  const secrets = await apiJson<unknown>('GET', `/oidc/clients/${CLIENT_ID}/secrets`)
  const list = Array.isArray(secrets) ? secrets : ((secrets as { data?: unknown[] }).data ?? [])
  if (list.length === 0) await apiJson('POST', `/oidc/clients/${CLIENT_ID}/secrets`, { secret: CLIENT_SECRET })
}

// A one-time link signs the dev user in to Pocket ID without a passkey.
export async function loginLink(): Promise<string> {
  const userId = await ensureUser()
  const { token } = await apiJson('POST', `/users/${userId}/one-time-access-token`, { ttl: '15m' })
  return `${ISSUER}/lc/${token}`
}

async function up() {
  docker('up', '-d')
  await waitForPocketId()
  await ensureUser()
  await ensureClient()
  writeFileSync(
    envFile,
    [
      `HOBWORK_OIDC_ISSUER=${ISSUER}`,
      `HOBWORK_OIDC_CLIENT_ID=${CLIENT_ID}`,
      `HOBWORK_OIDC_CLIENT_SECRET=${CLIENT_SECRET}`,
      `HOBWORK_ALLOWED_USERS=${USER.email}`,
      'HOBWORK_PUBLIC_URL=http://hobwork.localhost:5173',
      'HOBWORK_APPS_URL=http://apps.hobwork.localhost:7420',
      '',
    ].join('\n'),
  )
  console.log(`Pocket ID ready at ${ISSUER}. Wrote ${envFile}`)
  console.log(`Sign in to Pocket ID as ${USER.username}: ${await loginLink()}`)
}

async function reset() {
  docker('down', '--remove-orphans')
  // The container owns the files in data/; remove them from inside.
  if (existsSync(dataDir)) {
    execFileSync(
      'docker',
      ['run', '--rm', '-v', `${dataDir}:/data`, '--entrypoint', 'sh', 'ghcr.io/pocket-id/pocket-id:v2.16.0', '-c', 'rm -rf /data/* /data/.[!.]*'],
      { stdio: 'inherit' },
    )
    rmSync(dataDir, { recursive: true, force: true })
  }
  rmSync(envFile, { force: true })
  console.log('State wiped')
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? 'up'
  if (cmd === 'up') await up()
  else if (cmd === 'login-link') console.log(await loginLink())
  else if (cmd === 'down') docker('down')
  else if (cmd === 'reset') await reset()
  else {
    console.error('Usage: node dev/pocket-id/setup.ts [up|login-link|down|reset]')
    process.exit(1)
  }
}
