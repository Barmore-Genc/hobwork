import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createHomeAssistant, type HomeAssistant } from '../homeassistant/client.ts'
import { startFakeHomeAssistant, type FakeHomeAssistant } from '../homeassistant/fake-ha.ts'
import { createHomeAssistantSettings, type HomeAssistantSettings } from '../homeassistant/settings.ts'
import { createTriggerRegistry } from '../homeassistant/triggers.ts'
import { createProject, getProject } from '../projects.ts'
import { createRuntime, type Runtime } from '../runtime/runtime.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'
import { recordVersion } from '../versions.ts'

vi.setConfig({ testTimeout: 30_000 })

const silent = { info() {}, warn() {}, error() {} }

let host: ReturnType<typeof createTestHost>
let fake: FakeHomeAssistant
let key: Buffer
let settings: HomeAssistantSettings
let ha: HomeAssistant
let runtime: Runtime
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string

async function start(env?: { url: string; token: string }) {
  settings = createHomeAssistantSettings({ db: host.db, key, env })
  ha = createHomeAssistant({ connection: () => settings.connection(), logger: silent })
  const triggers = createTriggerRegistry({ ha, invoke: () => {}, logger: silent })
  runtime = createRuntime(host, { triggers })
  ha.start()
  await runtime.start()
  app = await startTestApp(host, { homeAssistant: ha, homeAssistantSettings: settings, runtime })
}

beforeEach(async () => {
  host = createTestHost()
  fake = await startFakeHomeAssistant()
  key = randomBytes(32)
  cookie = signedIn(host).cookie
  await createProject(host, 'lights')
  const commit = await seedMain(host, 'lights', {
    'package.json': fakePackageJson(),
    'hobwork.json': JSON.stringify({
      triggers: { desk: { homeassistant: { trigger: 'state', entity_id: 'input_button.desk' }, handler: 'src/desk.ts' } },
    }),
  })
  recordVersion(host, { projectId: getProject(host, 'lights')!.id, commit, summary: 'Desk button' })
})

afterEach(async () => {
  await app.close()
  await runtime.stop()
  ha.stop()
  await fake.close()
  host.dispose()
})

function call(method: string, path = '', body?: unknown, headers: Record<string, string> = writeHeaders(cookie)) {
  return fetch(`${app.base}/api/settings/homeassistant${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

test('saving the connection connects, subscribes waiting triggers, and never shows the token again', async () => {
  await start()
  expect(await (await call('GET')).json()).toMatchObject({ source: null, status: 'unconfigured', tokenSet: false })
  expect(fake.subscriptions).toHaveLength(0)

  const res = await call('PUT', '', { url: `${fake.url}/`, token: fake.token })
  expect(res.status).toBe(200)
  const saved = await res.json()
  expect(saved).toMatchObject({
    source: 'settings',
    url: fake.url,
    tokenSet: true,
    status: 'connected',
    version: 'fake',
    lastError: null,
    updatedBy: 'Kaan',
  })
  expect(JSON.stringify(saved)).not.toContain(fake.token)
  await vi.waitFor(() => expect(fake.subscriptions).toHaveLength(1))

  const row = host.db.prepare('SELECT token FROM homeassistant_settings').get()!
  expect(Buffer.from(row.token as Uint8Array).toString('latin1')).not.toContain(fake.token)
  expect(createHomeAssistantSettings({ db: host.db, key: randomBytes(32) }).connection()).toBeUndefined()
  expect(createHomeAssistantSettings({ db: host.db, key }).connection()).toEqual({ url: fake.url, token: fake.token })
})

test('a rejected token shows as the last error, and disconnecting stops the connection', async () => {
  await start()
  const wrong = await (await call('PUT', '', { url: fake.url, token: 'nope' })).json()
  expect(wrong).toMatchObject({ status: 'disconnected', lastError: 'access token rejected', version: null })

  // Keeping the saved token works only for the address it was entered for.
  expect((await call('PUT', '', { url: 'http://elsewhere.example:8123' })).status).toBe(400)
  expect((await call('PUT', '', { url: fake.url, token: fake.token })).status).toBe(200)
  expect(await (await call('PUT', '', { url: fake.url })).json()).toMatchObject({ status: 'connected' })

  const cleared = await (await call('DELETE')).json()
  expect(cleared).toMatchObject({ source: null, status: 'unconfigured', url: null })
  expect(ha.status).toBe('unconfigured')
  expect(host.db.prepare('SELECT count(*) AS n FROM homeassistant_settings').get()!.n).toBe(0)
})

test('testing a connection checks the address and token without saving them', async () => {
  await start()
  expect(await (await call('POST', '/test', { url: fake.url, token: fake.token })).json()).toEqual({ ok: true, version: 'fake' })
  expect(await (await call('POST', '/test', { url: fake.url, token: 'nope' })).json()).toMatchObject({ ok: false })
  expect(await (await call('POST', '/test', { url: 'http://127.0.0.1:1', token: 'x' })).json()).toMatchObject({ ok: false })
  expect((await call('POST', '/test', { url: 'homeassistant', token: 'x' })).status).toBe(400)
  expect(settings.source()).toBeUndefined()

  await call('PUT', '', { url: fake.url, token: fake.token })
  expect(await (await call('POST', '/test', {})).json()).toEqual({ ok: true, version: 'fake' })
  // The saved token is never sent to an address typed in.
  expect((await call('POST', '/test', { url: 'http://127.0.0.1:1' })).status).toBe(400)
})

test('the connection from the server configuration wins and cannot be changed here', async () => {
  await start({ url: fake.url, token: fake.token })
  await ha.waitUntilConnected()
  expect(await (await call('GET')).json()).toMatchObject({ source: 'env', url: fake.url, status: 'connected', tokenSet: true })
  expect((await call('PUT', '', { url: 'http://other.example', token: 'x' })).status).toBe(409)
  expect((await call('DELETE')).status).toBe(409)
  expect(settings.source()).toBe('env')
})

test('only signed-in people can read or change the connection', async () => {
  await start()
  const { token } = createAgentToken(host.db, 'claude')
  const agent = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  expect((await call('GET', '', undefined, agent)).status).toBe(401)
  expect((await call('PUT', '', { url: fake.url, token: fake.token }, agent)).status).toBe(401)
  expect((await call('POST', '/test', { url: fake.url, token: fake.token }, agent)).status).toBe(401)
  expect((await call('PUT', '', { url: fake.url, token: fake.token }, { cookie, 'content-type': 'application/json' })).status).toBe(403)
  expect(settings.source()).toBeUndefined()
})
