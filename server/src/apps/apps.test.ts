import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { startFakeOidcProvider, type FakeOidcProvider } from '../auth/fake-oidc.ts'
import { findSessionRecord } from '../auth/sessions.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, requireProject } from '../projects.ts'
import { projectFilesDir } from '../runtime/files.ts'
import { createRuntime, type Runtime } from '../runtime/runtime.ts'
import { fakeRuntimeSandboxes } from '../runtime/test-sandbox.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain, type Files } from '../test-project.ts'
import { appSessionCookie, sendTo, signedIn, startTestApp, TEST_PUBLIC_URL, type RawResponse } from '../test-web.ts'
import { recordVersion } from '../versions.ts'
import { appReturnPath, CALLBACK_PATH } from './http.ts'
import { createAppCode, CODE_TTL_MS } from './sessions.ts'

vi.setConfig({ testTimeout: 30_000 })

const FILAMENT = 'http://filament.apps.hobwork.test'
const SLEEP = 'http://sleep.apps.hobwork.test'
const FRAME_ANCESTORS = `frame-ancestors ${TEST_PUBLIC_URL}`

const HOBWORK_JSON = {
  routes: { 'GET /spools': { handler: 'src/spools.ts' }, 'POST /spools': { handler: 'src/add.ts' } },
}

// Stands in for `vite build`: a UI page, a hashed asset and two handlers.
const BUILD = [
  'mkdir -p dist/assets dist/handlers/src',
  `printf '<!doctype html><html><head><title>Spools</title></head><body>spools</body></html>' > dist/index.html`,
  `printf 'console.log(1)' > dist/assets/index-abc123.js`,
  `printf 'export default async (ctx) => ({ spools: 3, cookie: ctx.request.headers.get("cookie") })' > dist/handlers/src/spools.js`,
  `printf 'export default async (ctx) => ({ added: await ctx.request.text() })' > dist/handlers/src/add.js`,
].join(' && ')

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let runtime: Runtime
let sandboxes: ReturnType<typeof fakeRuntimeSandboxes>
let provider: FakeOidcProvider

const client = { id: 'hobwork', secret: 'test-secret' }
const kaan = { sub: 'sub-kaan', name: 'Kaan', email: 'kaan@example.com', email_verified: true }

async function release(project: string, files: Files) {
  const commit = await seedMain(host, project, files)
  return recordVersion(host, { projectId: requireProject(host, project).id, commit, summary: 'Track spools' })
}

beforeEach(async () => {
  host = createTestHost()
  provider = await startFakeOidcProvider(client)
  sandboxes = fakeRuntimeSandboxes()
  runtime = createRuntime(host, {
    createSandbox: sandboxes.factory,
    image: '/nonexistent-image',
    startBuildVm: startHostPipelineVm,
  })
  app = await startTestApp(host, {
    runtime,
    web: { oidc: { issuer: provider.issuer, clientId: client.id, clientSecret: client.secret, name: 'Pocket ID' } },
  })
  for (const name of ['filament', 'sleep']) {
    await createProject(host, name)
    await release(name, { 'package.json': fakePackageJson({ build: BUILD }), 'hobwork.json': JSON.stringify(HOBWORK_JSON) })
  }
})

afterEach(async () => {
  await app.close()
  await runtime.stop()
  await provider.close()
  host.dispose()
})

const send = (url: string, init?: Parameters<typeof sendTo>[2]) => sendTo(app.base, url, init)

function location(res: RawResponse): string {
  expect(res.status, res.body).toBeGreaterThanOrEqual(300)
  expect(res.status, res.body).toBeLessThan(400)
  return res.headers.location!
}

function setCookies(res: RawResponse): Map<string, string> {
  return new Map(
    (res.headers['set-cookie'] ?? []).map((c) => {
      const pair = c.split(';')[0]!
      return [pair.slice(0, pair.indexOf('=')), c]
    }),
  )
}

function cookiePair(header: string): string {
  return header.split(';')[0]!
}

const page = { accept: 'text/html,application/xhtml+xml' }

test('a signed-out deep link goes through Hobwork sign-in and lands on the same page', async () => {
  const start = await send(`${FILAMENT}/spools/7?tab=1`, { headers: page })
  expect(start.status).toBe(302)
  expect(start.headers['content-security-policy']).toContain(FRAME_ANCESTORS)
  const handoff = new URL(location(start))
  expect(handoff.origin).toBe(TEST_PUBLIC_URL)
  expect(handoff.pathname).toBe('/auth/app')
  expect(handoff.searchParams.get('project')).toBe('filament')
  expect(handoff.searchParams.get('returnTo')).toBe(`${FILAMENT}/spools/7?tab=1`)

  // No Hobwork session: sign in first, then come back.
  const login = new URL(location(await send(handoff.href)), TEST_PUBLIC_URL)
  expect(login.pathname).toBe('/login')
  const back = login.searchParams.get('returnTo')!
  expect(back).toBe(`${handoff.pathname}${handoff.search}`)

  // The sign-in page sends Pocket ID users to /auth/login with the same returnTo.
  const oidc = await send(`${TEST_PUBLIC_URL}/auth/login?returnTo=${encodeURIComponent(back)}`)
  const flow = cookiePair(setCookies(oidc).get('hobwork_oidc')!)
  const callback = new URL(provider.approve(location(oidc), kaan))
  const signedInRes = await send(callback.href, { headers: { cookie: flow } })
  expect(location(signedInRes)).toBe(back)
  const hobwork = cookiePair(setCookies(signedInRes).get('hobwork_session')!)

  const toApp = new URL(location(await send(`${TEST_PUBLIC_URL}${back}`, { headers: { cookie: hobwork } })))
  expect(toApp.origin).toBe(FILAMENT)
  expect(toApp.pathname).toBe(CALLBACK_PATH)
  expect(toApp.searchParams.get('returnTo')).toBe('/spools/7?tab=1')

  const exchanged = await send(toApp.href)
  expect(location(exchanged)).toBe('/spools/7?tab=1')
  const set = setCookies(exchanged).get('hobwork_app')!
  // Host-only: no Domain attribute, so other app origins never get it.
  expect(set).toMatch(/HttpOnly; SameSite=Lax/)
  expect(set).not.toMatch(/Domain=/i)
  const appCookie = cookiePair(set)

  const landed = await send(`${FILAMENT}/spools/7?tab=1`, { headers: { ...page, cookie: appCookie } })
  expect(landed.status).toBe(200)
  expect(landed.body).toContain('<head><base href="/"><title>Spools</title>')
  expect(landed.headers['content-security-policy']).toContain(FRAME_ANCESTORS)

  const route = await send(`${FILAMENT}/api/spools`, { headers: { cookie: appCookie } })
  expect(route.status).toBe(200)
  // The handler never sees the session cookie.
  expect(JSON.parse(route.body)).toEqual({ spools: 3, cookie: null })
})

test('with a Hobwork session the handoff goes straight to the app', async () => {
  const { cookie } = signedIn(host)
  const handoff = `${TEST_PUBLIC_URL}/auth/app?project=filament&returnTo=${encodeURIComponent(`${FILAMENT}/`)}`
  const toApp = new URL(location(await send(handoff, { headers: { cookie } })))
  expect(`${toApp.origin}${toApp.pathname}`).toBe(`${FILAMENT}${CALLBACK_PATH}`)
})

test('return addresses must be on the app origin the code is for', async () => {
  const { cookie } = signedIn(host)
  const handoff = (returnTo: string, project = 'filament') =>
    send(`${TEST_PUBLIC_URL}/auth/app?project=${project}&returnTo=${encodeURIComponent(returnTo)}`, { headers: { cookie } })
  for (const returnTo of [
    `${SLEEP}/`,
    'https://evil.example.com/',
    `http://filament.apps.hobwork.test.evil.example.com/`,
    'https://filament.apps.hobwork.test/',
    'http://filament.apps.hobwork.test:8080/',
    '/spools',
    '//evil.example.com/',
    'javascript:alert(1)',
    `${FILAMENT}${CALLBACK_PATH}?code=x`,
    '',
  ]) {
    const res = await handoff(returnTo)
    expect(res.status, returnTo).toBe(400)
  }
  expect((await handoff(`${FILAMENT}/`, 'nope')).status).toBe(400)
  expect((await handoff(`${FILAMENT}/`, 'sleep')).status).toBe(400)

  expect(appReturnPath('/spools?x=1', FILAMENT)).toBe('/spools?x=1')
  expect(appReturnPath('//evil.example.com/x', FILAMENT)).toBeUndefined()
  expect(appReturnPath('/\\evil.example.com', FILAMENT)).toBeUndefined()
  expect(appReturnPath('https://evil.example.com/', FILAMENT)).toBeUndefined()
  expect(appReturnPath('/_hobwork/callback', FILAMENT)).toBeUndefined()

  // A tampered returnTo on the callback falls back to the app's root.
  const session = findSessionRecord(host.db, cookie.split('=')[1]!)!
  const scope = { projectId: requireProject(host, 'filament').id, branch: null }
  for (const returnTo of ['//evil.example.com/', '/\\evil.example.com', 'https://evil.example.com/']) {
    const code = createAppCode(host.db, session.id, scope)
    const res = await send(`${FILAMENT}${CALLBACK_PATH}?code=${code}&returnTo=${encodeURIComponent(returnTo)}`)
    expect(location(res), returnTo).toBe('/')
  }
})

test('codes work once, expire, and only for the origin they were made for', async () => {
  const { cookie } = signedIn(host)
  const session = findSessionRecord(host.db, cookie.split('=')[1]!)!
  const filament = { projectId: requireProject(host, 'filament').id, branch: null }
  const exchange = (origin: string, code: string) => send(`${origin}${CALLBACK_PATH}?code=${code}&returnTo=/`)

  const code = createAppCode(host.db, session.id, filament)
  expect(setCookies(await exchange(FILAMENT, code)).has('hobwork_app')).toBe(true)
  const again = await exchange(FILAMENT, code)
  expect(again.status).toBe(400)
  expect(setCookies(again).has('hobwork_app')).toBe(false)

  const expired = createAppCode(host.db, session.id, filament, Date.now() - CODE_TTL_MS - 1)
  expect((await exchange(FILAMENT, expired)).status).toBe(400)

  // Used at another project's origin, a code gives nothing and is gone.
  const stolen = createAppCode(host.db, session.id, filament)
  expect((await exchange(SLEEP, stolen)).status).toBe(400)
  expect((await exchange(FILAMENT, stolen)).status).toBe(400)
  expect((await exchange(FILAMENT, 'forged')).status).toBe(400)
})

test('an app session works only on its own origin and never on Hobwork', async () => {
  const { cookie } = signedIn(host)
  const filament = appSessionCookie(host, cookie, 'filament')

  expect((await send(`${FILAMENT}/api/spools`, { headers: { cookie: filament } })).status).toBe(200)
  expect((await send(`${SLEEP}/api/spools`, { headers: { cookie: filament } })).status).toBe(401)
  const sleepPage = await send(`${SLEEP}/`, { headers: { ...page, cookie: filament } })
  expect(new URL(location(sleepPage)).pathname).toBe('/auth/app')

  // Hobwork's API and sign-in never accept it, under either cookie name.
  const token = filament.split('=')[1]!
  for (const c of [filament, `hobwork_session=${token}`]) {
    expect((await send(`${TEST_PUBLIC_URL}/api/projects`, { headers: { cookie: c } })).status).toBe(401)
    expect((await send(`${TEST_PUBLIC_URL}/api/secrets`, { headers: { cookie: c } })).status).toBe(401)
    expect(JSON.parse((await send(`${TEST_PUBLIC_URL}/api/session`, { headers: { cookie: c } })).body).user).toBeNull()
  }
  // And a Hobwork session is not an app session.
  expect((await send(`${FILAMENT}/api/spools`, { headers: { cookie } })).status).toBe(401)
  expect((await send(`${FILAMENT}/api/spools`, { headers: { cookie: `hobwork_app=${cookie.split('=')[1]}` } })).status).toBe(401)
})

test('signing out of Hobwork ends its app sessions', async () => {
  const { cookie } = signedIn(host)
  const filament = appSessionCookie(host, cookie, 'filament')
  const other = signedIn(host)
  const otherApp = appSessionCookie(host, other.cookie, 'filament')
  expect((await send(`${FILAMENT}/api/spools`, { headers: { cookie: filament } })).status).toBe(200)

  const out = await send(`${TEST_PUBLIC_URL}/auth/logout`, {
    method: 'POST',
    headers: { cookie, 'x-hobwork-csrf': '1', origin: TEST_PUBLIC_URL },
  })
  expect(out.status).toBe(204)
  expect((await send(`${FILAMENT}/api/spools`, { headers: { cookie: filament } })).status).toBe(401)
  expect((await send(`${FILAMENT}/api/spools`, { headers: { cookie: otherApp } })).status).toBe(200)
})

test('route writes from the app need the CSRF header and its own origin', async () => {
  const { cookie } = signedIn(host)
  const filament = appSessionCookie(host, cookie, 'filament')
  const post = (headers: Record<string, string>) =>
    send(`${FILAMENT}/api/spools`, { method: 'POST', headers: { cookie: filament, ...headers }, body: 'red' })

  expect((await post({})).status).toBe(403)
  // Sibling apps are same-site, so their requests carry SameSite=Lax cookies.
  expect((await post({ 'x-hobwork-csrf': '1', origin: SLEEP })).status).toBe(403)
  expect((await post({ 'x-hobwork-csrf': '1', 'sec-fetch-site': 'same-site' })).status).toBe(403)
  const ok = await post({ 'x-hobwork-csrf': '1', origin: FILAMENT, 'sec-fetch-site': 'same-origin' })
  expect(ok.status).toBe(200)
  expect(JSON.parse(ok.body)).toEqual({ added: 'red' })
})

test('app origins serve only the UI, never handler bundles or other files', async () => {
  const { cookie } = signedIn(host)
  const headers = { cookie: appSessionCookie(host, cookie, 'filament') }
  const asset = await send(`${FILAMENT}/assets/index-abc123.js`, { headers })
  expect(asset.status).toBe(200)
  expect(asset.headers['cache-control']).toContain('immutable')
  expect(asset.headers['content-security-policy']).toContain(FRAME_ANCESTORS)
  for (const path of [
    '/handlers/src/spools.js',
    '/%68andlers/src/spools.js',
    '/assets/..%2fhandlers/src/spools.js',
    '/..%2f..%2f..%2fhobwork.db',
    '/%00.js',
    '/assets/missing.js',
  ]) {
    const res = await send(`${FILAMENT}${path}`, { headers })
    expect(res.status, path).toBe(404)
    expect(res.body, path).not.toContain('export default')
  }
  expect((await send(`${FILAMENT}/`, { method: 'POST', headers })).status).toBe(405)
  expect((await send(`${FILAMENT}/_hobwork/other`, { headers })).status).toBe(404)
  // The theme loads without a session, like on Hobwork.
  expect((await send(`${FILAMENT}/theme/theme.css`)).status).toBe(200)
  expect((await send(`${FILAMENT}/assets/index-abc123.js`)).status).toBe(401)
  expect((await send('http://nope.apps.hobwork.test/', { headers: page })).status).toBe(404)
  expect((await send('http://a.b.apps.hobwork.test/', { headers: page })).status).toBe(404)
})

test('app origins serve the icons the build rendered, and a manifest, without a session', async () => {
  // Stands in for the icon renderer, which the host pipeline backend does not run.
  const icons = 'mkdir -p dist/_hobwork/icons && for s in 32 180 192 512; do printf png > dist/_hobwork/icons/icon-$s.png; done'
  await release('sleep', { 'package.json': fakePackageJson({ build: `${BUILD} && ${icons}` }), 'hobwork.json': JSON.stringify(HOBWORK_JSON) })
  // Nothing is built for a request without a session.
  expect((await send(`${SLEEP}/_hobwork/icons/icon-32.png`)).status).toBe(404)

  const { cookie } = signedIn(host)
  const html = await send(`${SLEEP}/`, { headers: { ...page, cookie: appSessionCookie(host, cookie, 'sleep') } })
  expect(html.body).toContain(
    '<head><base href="/"><link rel="icon" type="image/png" sizes="32x32" href="/_hobwork/icons/icon-32.png">' +
      '<link rel="apple-touch-icon" href="/_hobwork/icons/icon-180.png"><link rel="manifest" href="/_hobwork/manifest.webmanifest"><title>',
  )
  const icon = await send(`${SLEEP}/_hobwork/icons/icon-180.png`)
  expect(icon.status).toBe(200)
  expect(icon.headers['content-type']).toBe('image/png')
  expect(icon.body).toBe('png')
  const manifest = await send(`${SLEEP}/_hobwork/manifest.webmanifest`)
  expect(manifest.headers['content-type']).toBe('application/manifest+json')
  expect(JSON.parse(manifest.body)).toMatchObject({
    name: 'sleep',
    start_url: '/',
    display: 'standalone',
    icons: [
      { src: '/_hobwork/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/_hobwork/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  })
  for (const path of ['/_hobwork/icons/..%2f..%2findex.html', '/_hobwork/icons/..%2f..%2fhandlers/src/spools.js', '/_hobwork/icons/nope.png']) {
    expect((await send(`${SLEEP}${path}`)).status, path).toBe(404)
  }

  // A build without icons gets no links.
  const plain = await send(`${FILAMENT}/`, { headers: { ...page, cookie: appSessionCookie(host, cookie, 'filament') } })
  expect(plain.body).toContain('<head><base href="/"><title>')
  expect(JSON.parse((await send(`${FILAMENT}/_hobwork/manifest.webmanifest`)).body).icons).toEqual([])
})

test('agents call routes on Hobwork with a token; old UI links move to the app origin', async () => {
  const { token } = createAgentToken(host.db, 'claude')
  const { cookie } = signedIn(host)
  expect((await send(`${TEST_PUBLIC_URL}/p/filament/api/spools`, { headers: { cookie } })).status).toBe(401)
  const byAgent = await send(`${TEST_PUBLIC_URL}/p/filament/api/spools`, { headers: { authorization: `Bearer ${token}` } })
  expect(byAgent.status).toBe(200)
  expect((await send(`${FILAMENT}/api/spools`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)

  expect(location(await send(`${TEST_PUBLIC_URL}/p/filament/spools/7?tab=1`, { headers: { cookie } }))).toBe(
    `${FILAMENT}/spools/7?tab=1`,
  )
  expect(location(await send(`${TEST_PUBLIC_URL}/p/filament`))).toBe(`${FILAMENT}/`)
  expect((await send(`${TEST_PUBLIC_URL}/p/nope/`)).status).toBe(404)
})

test('the project page links to the app origin', async () => {
  const { cookie } = signedIn(host)
  const detail = JSON.parse((await send(`${TEST_PUBLIC_URL}/api/projects/filament`, { headers: { cookie } })).body)
  expect(detail.appUrl).toBe(FILAMENT)
})

test('UI and route responses on an app origin carry the default policy and nosniff', async () => {
  const { cookie } = signedIn(host)
  const headers = { cookie: appSessionCookie(host, cookie, 'filament') }
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    FRAME_ANCESTORS,
  ].join('; ')
  for (const path of ['/', '/assets/index-abc123.js', '/api/spools', '/api/missing']) {
    const res = await send(`${FILAMENT}${path}`, { headers: { ...headers, ...page } })
    expect(res.headers['content-security-policy'], path).toBe(policy)
    expect(res.headers['x-content-type-options'], path).toBe('nosniff')
  }
})

test('hobwork.json adds sources to the policy, and a handler policy is sent as well', async () => {
  const bundle = [
    'mkdir -p dist/handlers/src',
    `printf '<!doctype html><html><head></head><body></body></html>' > dist/index.html`,
    `printf 'export default async () => new Response("x", { headers: { "content-security-policy": "sandbox" } })' > dist/handlers/src/csp.js`,
  ].join(' && ')
  await createProject(host, 'loose')
  await release('loose', {
    'package.json': fakePackageJson({ build: bundle }),
    'hobwork.json': JSON.stringify({
      routes: { 'GET /csp': { handler: 'src/csp.ts' } },
      csp: { 'script-src': ['https://cdn.example.com'], 'connect-src': ['wss://live.example.com:8443'], 'worker-src': ['https://w.example.com'] },
    }),
  })
  const { cookie } = signedIn(host)
  const headers = { cookie: appSessionCookie(host, cookie, 'loose') }
  const base = 'http://loose.apps.hobwork.test'
  const ui = await send(`${base}/`, { headers: { ...headers, ...page } })
  const policy = ui.headers['content-security-policy'] as string
  expect(policy).toContain("script-src 'self' https://cdn.example.com;")
  expect(policy).toContain("connect-src 'self' wss://live.example.com:8443;")
  expect(policy).toContain("worker-src 'self' https://w.example.com;")
  expect(policy).toContain(FRAME_ANCESTORS)
  expect(policy).toContain("object-src 'none'")

  const route = await send(`${base}/api/csp`, { headers })
  expect(route.status).toBe(200)
  // Node joins repeated headers with a comma, which browsers read as two policies.
  expect(route.headers['content-security-policy']).toBe(`${policy}, sandbox`)
})

test('another hob\'s app is refused unless hobwork.json lists it, on every method', async () => {
  await createProject(host, 'open')
  await release('open', {
    'package.json': fakePackageJson({ build: BUILD }),
    'hobwork.json': JSON.stringify({ ...HOBWORK_JSON, crossAppRequests: ['sleep'] }),
  })
  const { cookie } = signedIn(host)
  const filament = appSessionCookie(host, cookie, 'filament')
  const open = appSessionCookie(host, cookie, 'open')
  const OPEN = 'http://open.apps.hobwork.test'
  const fromSleep = { origin: SLEEP, 'sec-fetch-site': 'same-site' }

  for (const headers of [fromSleep, { referer: `${SLEEP}/page`, 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'script' }]) {
    const get = await send(`${FILAMENT}/api/spools`, { headers: { cookie: filament, ...headers } })
    expect(get.status).toBe(403)
    expect(JSON.parse(get.body).error).toContain('sleep')
    expect((await send(`${FILAMENT}/assets/index-abc123.js`, { headers: { cookie: filament, ...headers } })).status).toBe(403)
    expect((await send(`${OPEN}/api/spools`, { headers: { cookie: open, ...headers } })).status).toBe(200)
  }

  const write = { 'x-hobwork-csrf': '1', ...fromSleep }
  expect((await send(`${FILAMENT}/api/spools`, { method: 'POST', headers: { cookie: filament, ...write }, body: 'red' })).status).toBe(403)
  const listed = await send(`${OPEN}/api/spools`, { method: 'POST', headers: { cookie: open, ...write }, body: 'red' })
  expect(listed.status).toBe(200)
  expect((await send(`${OPEN}/api/spools`, { method: 'POST', headers: { cookie: open, origin: SLEEP }, body: 'red' })).status).toBe(403)

  // The list is one way: open is not on filament's list, and filament is not on open's.
  const fromFilament = { origin: FILAMENT, 'sec-fetch-site': 'same-site' }
  expect((await send(`${OPEN}/api/spools`, { headers: { cookie: open, ...fromFilament } })).status).toBe(403)
  expect((await send(`${SLEEP}/api/spools`, { headers: { cookie: appSessionCookie(host, cookie, 'sleep'), origin: OPEN, 'sec-fetch-site': 'same-site' } })).status).toBe(403)
})

test('the Hobwork UI, links, own previews and other sites still reach an app', async () => {
  const { cookie } = signedIn(host)
  const filament = appSessionCookie(host, cookie, 'filament')
  const get = (path: string, headers: Record<string, string>) => send(`${FILAMENT}${path}`, { headers: { cookie: filament, ...headers } })

  const frame = { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'iframe' }
  expect((await get('/', { ...frame, referer: `${TEST_PUBLIC_URL}/hobs/filament` })).status).toBe(200)
  expect((await get('/', frame)).status).toBe(200)
  expect((await get('/api/spools', { ...frame, referer: `${TEST_PUBLIC_URL}/` })).status).toBe(200)
  expect((await get('/api/spools', { 'sec-fetch-site': 'same-site' })).status).toBe(403)
  expect((await get('/api/spools', { ...frame })).status).toBe(403)

  const link = { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', referer: `${SLEEP}/` }
  expect((await get('/spools/1', link)).status).toBe(200)
  expect((await get('/api/spools', link)).status).toBe(403)
  expect((await get('/', { ...frame, referer: `${SLEEP}/` })).status).toBe(403)

  expect((await get('/api/spools', { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  expect((await get('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document', origin: 'https://evil.example' })).status).toBe(200)
  expect((await get('/api/spools', { 'sec-fetch-site': 'same-site', origin: 'http://blog.hobwork.test' })).status).toBe(403)
  expect((await send(`${FILAMENT}/api/spools`, { headers: { cookie: filament } })).status).toBe(200)
})

const FILES_JSON = {
  ...HOBWORK_JSON,
  routes: { ...HOBWORK_JSON.routes, 'PUT /photos/:name': { handler: 'src/upload.ts' } },
  static: { '/photos': { dir: 'photos' }, '/shared': { dir: 'shared/out', public: true } },
}
const UPLOAD = `printf 'export default async (ctx) => ctx.files.put("photos/" + ctx.params.name, await ctx.request.text())' > dist/handlers/src/upload.js`

function storeFile(project: string, path: string, contents: string) {
  const target = join(projectFilesDir(host, project), ...path.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

async function releaseWithFiles() {
  await release('filament', { 'package.json': fakePackageJson({ build: `${BUILD} && ${UPLOAD}` }), 'hobwork.json': JSON.stringify(FILES_JSON) })
}

test('static mounts serve the files handlers store, without starting a VM', async () => {
  await releaseWithFiles()
  const { cookie } = signedIn(host)
  const session = { cookie: appSessionCookie(host, cookie, 'filament') }
  storeFile('filament', 'photos/2026/cat.jpg', 'meow')

  const photo = await send(`${FILAMENT}/photos/2026/cat.jpg`, { headers: session })
  expect(photo.status).toBe(200)
  expect(photo.body).toBe('meow')
  expect(photo.headers['content-type']).toBe('image/jpeg')
  expect(photo.headers['cache-control']).toBe('private, no-cache')
  expect(photo.headers['x-content-type-options']).toBe('nosniff')
  expect(sandboxes.created).toHaveLength(0)

  const again = await send(`${FILAMENT}/photos/2026/cat.jpg`, { headers: { ...session, 'if-none-match': photo.headers.etag as string } })
  expect(again.status).toBe(304)
  const part = await send(`${FILAMENT}/photos/2026/cat.jpg`, { headers: { ...session, range: 'bytes=1-2' } })
  expect(part.status).toBe(206)
  expect(part.body).toBe('eo')
  expect(part.headers['content-range']).toBe('bytes 1-2/4')
  expect((await send(`${FILAMENT}/photos/2026/cat.jpg`, { headers: { ...session, range: 'bytes=-1' } })).body).toBe('w')
  expect((await send(`${FILAMENT}/photos/2026/cat.jpg`, { headers: { ...session, range: 'bytes=9-' } })).status).toBe(416)
  // A range for another version of the file gets the whole file.
  const stale = await send(`${FILAMENT}/photos/2026/cat.jpg`, { headers: { ...session, range: 'bytes=1-2', 'if-range': '"old"' } })
  expect(stale.status).toBe(200)
  expect(stale.body).toBe('meow')

  // Private mounts need the app session like the UI.
  expect((await send(`${FILAMENT}/photos/2026/cat.jpg`)).status).toBe(401)
  expect(location(await send(`${FILAMENT}/photos/2026/cat.jpg`, { headers: page }))).toContain('/auth/app')

  // A route stores a file through ctx.files, and the mount serves it.
  const upload = await send(`${FILAMENT}/api/photos/dog.png`, {
    method: 'PUT',
    headers: { ...session, 'x-hobwork-csrf': '1' },
    body: 'woof',
  })
  expect(upload.status, upload.body).toBe(200)
  expect(JSON.parse(upload.body)).toMatchObject({ path: 'photos/dog.png', size: 4 })
  const dog = await send(`${FILAMENT}/photos/dog.png`, { headers: session })
  expect(dog.body).toBe('woof')
  expect(dog.headers['content-type']).toBe('image/png')
})

test('public mounts need no session, and nothing outside a mount is served', async () => {
  await releaseWithFiles()
  storeFile('filament', 'shared/out/plan.pdf', '%PDF')
  storeFile('filament', 'shared/out/logo.svg', '<svg/>')
  storeFile('filament', 'shared/out/page.html', '<script>alert(1)</script>')
  storeFile('filament', 'shared/out/app.js', 'alert(1)')
  storeFile('filament', 'shared/secret.txt', 'not shared')
  storeFile('filament', 'photos/cat.jpg', 'meow')

  const pdf = await send(`${FILAMENT}/shared/plan.pdf`)
  expect(pdf.status).toBe(200)
  expect(pdf.headers['content-type']).toBe('application/pdf')
  expect(pdf.headers['cache-control']).toBe('public, no-cache')
  expect(pdf.headers['content-security-policy']).toBeUndefined()
  // From another hob's app too: the files are public.
  expect((await send(`${FILAMENT}/shared/plan.pdf`, { headers: { origin: SLEEP, 'sec-fetch-site': 'same-site' } })).status).toBe(200)

  const svg = await send(`${FILAMENT}/shared/logo.svg`)
  expect(svg.headers['content-type']).toBe('image/svg+xml')
  expect(svg.headers['content-security-policy']).toContain('sandbox')
  // What could run script on the app origin is a download, never a page or script.
  for (const path of ['/shared/page.html', '/shared/app.js']) {
    const res = await send(`${FILAMENT}${path}`)
    expect(res.headers['content-type'], path).toBe('application/octet-stream')
    expect(res.headers['content-disposition'], path).toBe('attachment')
  }

  for (const path of [
    '/shared/',
    '/shared',
    '/shared/missing.pdf',
    '/shared/..%2fsecret.txt',
    '/shared/%2e%2e/secret.txt',
    '/shared/..%2f..%2fphotos/cat.jpg',
    '/shared/.%2e/secret.txt',
    '/shared/a%00.txt',
  ]) {
    // URL parsing turns /shared/%2e%2e/ into /, which needs a session.
    const res = await send(`${FILAMENT}${path}`)
    expect([401, 404], path).toContain(res.status)
    expect(res.body, path).not.toContain('not shared')
  }
  expect((await send(`${FILAMENT}/shared/plan.pdf`, { method: 'POST' })).status).toBe(405)
  expect(sandboxes.created).toHaveLength(0)

  // A mount wins over the UI: no index.html for paths under it.
  const { cookie } = signedIn(host)
  const missing = await send(`${FILAMENT}/photos/nope`, { headers: { ...page, cookie: appSessionCookie(host, cookie, 'filament') } })
  expect(missing.status).toBe(404)
  expect(missing.body).not.toContain('<title>Spools</title>')
})
