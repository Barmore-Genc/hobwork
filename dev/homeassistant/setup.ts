// Usage: node dev/homeassistant/setup.ts [up|down|reset]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const compose = join(dir, 'compose.yaml')
const envFile = join(dir, '.env.local')
const dataDir = join(dir, 'data')

const URL_BASE = process.env.HOBWORK_HA_URL ?? 'http://localhost:18123'
const CLIENT_ID = `${URL_BASE}/`
const USER = { name: 'Hobwork', username: 'hobwork', password: 'hobwork-dev-password', language: 'en' }

function docker(...args: string[]) {
  execFileSync('docker', ['compose', '-f', compose, ...args], { stdio: 'inherit' })
}

function readEnv(): Record<string, string> {
  if (!existsSync(envFile)) return {}
  return Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
}

async function waitForHa() {
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(`${URL_BASE}/api/onboarding`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('Home Assistant did not come up within 6 minutes')
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<Record<string, any>>
}

async function tokenWorks(token: string) {
  try {
    const res = await fetch(`${URL_BASE}/api/`, { headers: { authorization: `Bearer ${token}` } })
    return res.ok
  } catch {
    return false
  }
}

async function onboard(): Promise<string> {
  const status = (await (await fetch(`${URL_BASE}/api/onboarding`)).json()) as { step: string; done: boolean }[]
  const done = new Set(status.filter((s) => s.done).map((s) => s.step))

  if (done.has('user')) {
    throw new Error(
      'HA is onboarded but .env.local has no working token. Run `node dev/homeassistant/setup.ts reset` to start clean.',
    )
  }

  const { auth_code } = await post('/api/onboarding/users', { client_id: CLIENT_ID, ...USER })
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: auth_code, client_id: CLIENT_ID })
  const res = await fetch(`${URL_BASE}/auth/token`, { method: 'POST', body })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`)
  const { access_token } = (await res.json()) as { access_token: string }

  await post('/api/onboarding/core_config', {}, access_token)
  await post('/api/onboarding/analytics', {}, access_token)
  await post('/api/onboarding/integration', { client_id: CLIENT_ID, redirect_uri: `${URL_BASE}/?auth_callback=1` }, access_token)
  return access_token
}

function longLivedToken(accessToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL_BASE.replace(/^http/, 'ws')}/api/websocket`)
    ws.onerror = () => reject(new Error('websocket error'))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: accessToken }))
      else if (msg.type === 'auth_ok')
        ws.send(
          JSON.stringify({
            id: 1,
            type: 'auth/long_lived_access_token',
            client_name: 'hobwork-dev',
            lifespan: 3650,
          }),
        )
      else if (msg.type === 'result' && msg.id === 1) {
        ws.close()
        if (msg.success) resolve(msg.result)
        else reject(new Error(JSON.stringify(msg.error)))
      } else if (msg.type === 'auth_invalid') reject(new Error('auth_invalid'))
    }
  })
}

async function up() {
  docker('up', '-d')
  await waitForHa()

  const existing = readEnv().HOBWORK_HA_TOKEN
  if (existing && (await tokenWorks(existing))) {
    console.log('Already onboarded, reusing token from .env.local')
  } else {
    const token = await longLivedToken(await onboard())
    writeFileSync(envFile, `HOBWORK_HA_URL=${URL_BASE}\nHOBWORK_HA_TOKEN=${token}\n`)
    console.log('Onboarded. Wrote .env.local')
  }
  console.log(`Home Assistant ready at ${URL_BASE}`)
}

async function reset() {
  docker('down', '--remove-orphans')
  // Container runs as root and owns files in data/; remove them from inside.
  if (existsSync(dataDir)) {
    execFileSync('docker', ['run', '--rm', '-v', `${dataDir}:/config`, '--entrypoint', 'sh',
      'ghcr.io/home-assistant/home-assistant:stable', '-c', 'rm -rf /config/* /config/.[!.]*'], { stdio: 'inherit' })
    rmSync(dataDir, { recursive: true, force: true })
  }
  rmSync(envFile, { force: true })
  console.log('State wiped')
}

const cmd = process.argv[2] ?? 'up'
if (cmd === 'up') await up()
else if (cmd === 'down') docker('down')
else if (cmd === 'reset') await reset()
else {
  console.error('Usage: node dev/homeassistant/setup.ts [up|down|reset]')
  process.exit(1)
}
