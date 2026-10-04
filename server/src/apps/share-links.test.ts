import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken, revokeAgentToken, verifyAgentToken } from '../agents.ts'
import { runHousekeeping } from '../housekeeping.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, requireProject } from '../projects.ts'
import { createBranch } from '../repo.ts'
import { createRuntime, type Runtime } from '../runtime/runtime.ts'
import { fakeRuntimeSandboxes } from '../runtime/test-sandbox.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { appSessionCookie, sendTo, signedIn, startTestApp, TEST_PUBLIC_URL, type RawResponse } from '../test-web.ts'
import { recordVersion } from '../versions.ts'
import { SHARE_PATH } from './http.ts'
import { createShareLink, SHARE_LINK_TTL_MS } from './share-links.ts'

vi.setConfig({ testTimeout: 30_000 })

const FILAMENT = 'http://filament.apps.hobwork.test'
const SLEEP = 'http://sleep.apps.hobwork.test'
const PREVIEW = 'http://add-spools--filament.apps.hobwork.test'

const HOBWORK_JSON = {
  routes: { 'GET /spools': { handler: 'src/spools.ts' }, 'POST /spools': { handler: 'src/add.ts' } },
}

const BUILD = [
  'mkdir -p dist/assets dist/handlers/src',
  `printf '<!doctype html><html><head><title>Spools</title></head><body>spools</body></html>' > dist/index.html`,
  `printf 'export default async (ctx) => ({ spools: 3, auth: ctx.request.headers.get("authorization") })' > dist/handlers/src/spools.js`,
  `printf 'export default async (ctx) => ({ added: await ctx.request.text() })' > dist/handlers/src/add.js`,
].join(' && ')

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let runtime: Runtime

beforeEach(async () => {
  host = createTestHost()
  runtime = createRuntime(host, {
    createSandbox: fakeRuntimeSandboxes().factory,
    image: '/nonexistent-image',
    startBuildVm: startHostPipelineVm,
  })
  app = await startTestApp(host, { runtime })
  for (const name of ['filament', 'sleep']) {
    await createProject(host, name)
    const commit = await seedMain(host, name, { 'package.json': fakePackageJson({ build: BUILD }), 'hobwork.json': JSON.stringify(HOBWORK_JSON) })
    recordVersion(host, { projectId: requireProject(host, name).id, commit, summary: 'Track spools' })
  }
})

afterEach(async () => {
  await app.close()
  await runtime.stop()
  host.dispose()
})

const send = (url: string, init?: Parameters<typeof sendTo>[2]) => sendTo(app.base, url, init)
const page = { accept: 'text/html' }
// How a browser opens the link in an MCP client's frame: a cross-site navigation.
const framed = { ...page, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }

function agent(access = { readOnly: false, projects: null as string[] | null }) {
  const { token } = createAgentToken(host.db, `claude-${Math.random()}`, access)
  return { token, agent: verifyAgentToken(host.db, token)! }
}

function link(project: string, options: { branch?: string; readOnly?: boolean; now?: number } = {}) {
  const made = agent({ readOnly: options.readOnly ?? false, projects: null })
  const scope = { projectId: requireProject(host, project).id, branch: options.branch ?? null }
  return { ...createShareLink(host.db, made.agent, scope, options.now), credential: made }
}

function shareCookie(res: RawResponse): string {
  const set = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('hobwork_share='))
  expect(set, res.body).toBeDefined()
  return set!
}

test('a share link opens its app in a frame on another site, without signing in', async () => {
  const { token } = link('filament')
  const opened = await send(`${FILAMENT}${SHARE_PATH}?token=${token}&returnTo=${encodeURIComponent('/spools/7')}`, { headers: framed })
  expect(opened.status).toBe(302)
  expect(opened.headers.location).toBe('/spools/7')
  const set = shareCookie(opened)
  // The frame is cross-site, so the cookie has to be SameSite=None, and
  // partitioned so browsers that block third-party cookies keep it.
  expect(set).toMatch(/HttpOnly; SameSite=None; Secure; Partitioned/)
  expect(set).not.toMatch(/Domain=/i)
  const cookie = set.split(';')[0]!

  const landed = await send(`${FILAMENT}/spools/7`, { headers: { ...framed, cookie } })
  expect(landed.status).toBe(200)
  expect(landed.body).toContain('<title>Spools</title>')
  expect(landed.headers['content-security-policy']).toContain('frame-ancestors *')

  const same = { cookie, 'sec-fetch-site': 'same-origin' }
  const route = await send(`${FILAMENT}/api/spools`, { headers: same })
  expect(route.status).toBe(200)
  expect(route.headers['content-security-policy']).toContain('frame-ancestors *')
  const write = await send(`${FILAMENT}/api/spools`, {
    method: 'POST',
    headers: { ...same, 'x-hobwork-csrf': '1', origin: FILAMENT },
    body: 'red',
  })
  expect(JSON.parse(write.body)).toEqual({ added: 'red' })
  // Writes still need the CSRF header.
  expect((await send(`${FILAMENT}/api/spools`, { method: 'POST', headers: same, body: 'red' })).status).toBe(403)
})

test('other sites cannot use the share cookie for routes, and signed-in sessions keep their framing rule', async () => {
  const { token } = link('filament')
  const cookie = `hobwork_share=${token}`
  // Sibling apps are turned away before the session is read.
  for (const [site, status] of [['cross-site', 401], ['same-site', 403]] as const) {
    const res = await send(`${FILAMENT}/api/spools`, { headers: { cookie, 'sec-fetch-site': site, 'sec-fetch-mode': 'cors' } })
    expect(res.status, site).toBe(status)
  }
  // A cross-site subresource is not a page anyone opened.
  const embedded = await send(`${FILAMENT}/`, { headers: { ...page, cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } })
  expect(embedded.status).toBe(302)

  const { cookie: hobwork } = signedIn(host)
  const own = await send(`${FILAMENT}/`, { headers: { ...page, cookie: appSessionCookie(host, hobwork, 'filament') } })
  expect(own.status).toBe(200)
  expect(own.headers['content-security-policy']).toContain(`frame-ancestors ${TEST_PUBLIC_URL}`)
})

test('agents call routes with the token as a bearer token, which never reaches the handler', async () => {
  const { token } = link('filament')
  const res = await send(`${FILAMENT}/api/spools`, { headers: { authorization: `Bearer ${token}` } })
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ spools: 3, auth: null })
  const write = await send(`${FILAMENT}/api/spools`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'blue' })
  expect(JSON.parse(write.body)).toEqual({ added: 'blue' })
  const ui = await send(`${FILAMENT}/`, { headers: { ...page, authorization: `Bearer ${token}` } })
  expect(ui.body).toContain('<title>Spools</title>')

  const forged = await send(`${FILAMENT}/api/spools`, { headers: { authorization: 'Bearer hws_forged' } })
  expect(forged.status).toBe(401)
})

test('a link opens only its own hob and branch', async () => {
  await createBranch(host, 'filament', 'add-spools', 'main')
  const main = link('filament')
  const branch = link('filament', { branch: 'add-spools' })
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  expect((await send(`${SLEEP}/api/spools`, { headers: bearer(main.token) })).status).toBe(401)
  expect((await send(`${PREVIEW}/api/spools`, { headers: bearer(main.token) })).status).toBe(401)
  expect((await send(`${FILAMENT}/api/spools`, { headers: bearer(branch.token) })).status).toBe(401)
  expect((await send(`${PREVIEW}/api/spools`, { headers: bearer(branch.token) })).status).toBe(200)

  const elsewhere = await send(`${SLEEP}${SHARE_PATH}?token=${main.token}`, { headers: framed })
  expect(elsewhere.status).toBe(401)
  expect(elsewhere.headers['set-cookie']).toBeUndefined()
  // A framed page explains itself rather than redirecting to sign-in pages that refuse frames.
  expect(elsewhere.headers['content-security-policy']).toContain('frame-ancestors *')
  expect(elsewhere.body).toContain('expired or was revoked')
})

test('a read-only connection makes a link that only reads', async () => {
  const { token } = link('filament', { readOnly: true })
  expect((await send(`${FILAMENT}/api/spools`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
  const write = await send(`${FILAMENT}/api/spools`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'red' })
  expect(write.status).toBe(403)
  const cookieWrite = await send(`${FILAMENT}/api/spools`, {
    method: 'POST',
    headers: { cookie: `hobwork_share=${token}`, 'x-hobwork-csrf': '1', origin: FILAMENT, 'sec-fetch-site': 'same-origin' },
    body: 'red',
  })
  expect(cookieWrite.status).toBe(403)
})

test('links stop working when they expire or their credential is revoked, and housekeeping removes expired ones', async () => {
  // Made last: making a link removes expired ones.
  const live = link('filament')
  const old = link('filament', { now: Date.now() - SHARE_LINK_TTL_MS - 1000 })
  const expired = await send(`${FILAMENT}/`, { headers: { ...framed, cookie: `hobwork_share=${old.token}` } })
  expect(expired.status).toBe(401)
  expect(expired.body).toContain('expired or was revoked')

  const cookie = `hobwork_share=${live.token}`
  expect((await send(`${FILAMENT}/`, { headers: { ...framed, cookie } })).status).toBe(200)
  revokeAgentToken(host.db, live.credential.agent.credential!.id)
  expect((await send(`${FILAMENT}/`, { headers: { ...framed, cookie } })).status).toBe(401)

  const count = () => Number(host.db.prepare('SELECT count(*) AS n FROM app_share_links').get()!.n)
  expect(count()).toBe(2)
  await runHousekeeping(host)
  // The revoked link stays until it expires; it opens nothing either way.
  expect(count()).toBe(1)
})
