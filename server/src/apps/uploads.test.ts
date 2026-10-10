import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { UPLOAD_CHUNK_BYTES } from '../../../packages/sdk/src/uploads.ts'
import { runHousekeeping } from '../housekeeping.ts'
import { hostTimeZone } from '../people.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, requireProject } from '../projects.ts'
import { projectFilesDir } from '../runtime/files.ts'
import { createRuntime, type Runtime } from '../runtime/runtime.ts'
import { fakeRuntimeSandboxes } from '../runtime/test-sandbox.ts'
import { rotateUploadToken, UPLOAD_EXPIRY_MS } from '../runtime/uploads.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { appSessionCookie, sendTo, signedIn, startTestApp } from '../test-web.ts'
import { recordVersion } from '../versions.ts'

vi.setConfig({ testTimeout: 30_000 })

const FILAMENT = 'http://filament.apps.hobwork.test'
const SLEEP = 'http://sleep.apps.hobwork.test'

const HOBWORK_JSON = {
  uploads: {
    inbox: { prefix: 'inbox/', maxBytes: 64 * 1024 * 1024, types: ['.3mf', 'image/*'] },
    small: { prefix: 'inbox/small/', maxBytes: 10 },
  },
  triggers: { arrived: { upload: 'inbox', handler: 'src/arrived.ts' } },
}

// The trigger stores what it got, so the test can read it.
const BUILD = [
  'mkdir -p dist/handlers/src',
  `printf 'export default async (ctx) => ctx.files.put("seen/" + ctx.payload.path.split("/").pop() + ".json", JSON.stringify({ payload: ctx.payload, caller: ctx.caller }))' > dist/handlers/src/arrived.js`,
].join(' && ')

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let runtime: Runtime

beforeEach(async () => {
  host = createTestHost()
  runtime = createRuntime(host, { createSandbox: fakeRuntimeSandboxes().factory, image: '/nonexistent-image', startBuildVm: startHostPipelineVm })
  app = await startTestApp(host, { runtime, web: { allowlist: { emails: ['kaan@example.com', 'ayse@example.com'], subjects: [] } } })
  for (const name of ['filament', 'sleep']) {
    await createProject(host, name)
    const commit = await seedMain(host, name, { 'package.json': fakePackageJson({ build: BUILD }), 'hobwork.json': JSON.stringify(HOBWORK_JSON) })
    recordVersion(host, { projectId: requireProject(host, name).id, commit, summary: 'Take uploads' })
  }
})

afterEach(async () => {
  await app.close()
  await runtime.stop()
  host.dispose()
})

const send = (url: string, init?: Parameters<typeof sendTo>[2]) => sendTo(app.base, url, init)
const stored = (path: string) => join(projectFilesDir(host, 'filament'), ...path.split('/'))

async function seen(name: string): Promise<{ payload: unknown; caller: unknown }> {
  await vi.waitFor(() => expect(existsSync(stored(`seen/${name}.json`))).toBe(true), { timeout: 20_000 })
  return JSON.parse(readFileSync(stored(`seen/${name}.json`), 'utf8'))
}

function session(email?: string) {
  const { user, cookie } = signedIn(host, email)
  const app = appSessionCookie(host, cookie, 'filament')
  return { user, headers: { cookie: app, 'x-hobwork-csrf': '1', origin: FILAMENT, 'sec-fetch-site': 'same-origin' } }
}

test('the app uploads a file in parts past the route body limit, and the trigger gets it with the caller', async () => {
  const { user, headers } = session()
  const size = UPLOAD_CHUNK_BYTES + 3 * 1024 * 1024
  const body = 'x'.repeat(size)
  const start = await send(`${FILAMENT}/_hobwork/uploads`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'inbox/benchy.3mf', size, type: 'model/3mf' }),
  })
  expect(start.status, start.body).toBe(201)
  const { id, chunkBytes, received } = JSON.parse(start.body)
  expect({ chunkBytes, received }).toEqual({ chunkBytes: UPLOAD_CHUNK_BYTES, received: 0 })

  const part = (offset: number, data: string) => send(`${FILAMENT}/_hobwork/uploads/${id}?offset=${offset}`, { method: 'PUT', headers, body: data })
  // A part must start where the upload stands.
  expect((await part(5, 'x')).status).toBe(409)
  const first = await part(0, body.slice(0, chunkBytes))
  expect(first.status, first.body).toBe(200)
  expect(JSON.parse(first.body)).toMatchObject({ received: chunkBytes, size })
  // After a dropped connection the app asks where to go on.
  expect(JSON.parse((await send(`${FILAMENT}/_hobwork/uploads/${id}`, { headers })).body)).toMatchObject({ received: chunkBytes })
  expect(existsSync(stored('inbox/benchy.3mf'))).toBe(false)

  const last = await part(chunkBytes, body.slice(chunkBytes))
  expect(last.status, last.body).toBe(201)
  expect(JSON.parse(last.body)).toEqual({ done: true, file: { path: 'inbox/benchy.3mf', size, modified: expect.any(String) } })
  expect(readFileSync(stored('inbox/benchy.3mf'), 'utf8')).toBe(body)
  expect((await send(`${FILAMENT}/_hobwork/uploads/${id}`, { headers })).status).toBe(404)

  expect(await seen('benchy.3mf')).toEqual({
    payload: { upload: 'inbox', path: 'inbox/benchy.3mf', size, modified: expect.any(String), contentType: 'model/3mf' },
    caller: { person: { id: user.id, name: 'Kaan', email: 'kaan@example.com', timeZone: hostTimeZone() }, device: null },
  })
})

test('uploads keep to the declared folders, sizes and types', async () => {
  const { headers } = session()
  const json = { ...headers, 'content-type': 'application/json' }
  const start = (path: string, size: number, type?: string) =>
    send(`${FILAMENT}/_hobwork/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ path, size, type }) })
  expect((await start('photos/cat.jpg', 3, 'image/jpeg')).status).toBe(403)
  expect((await start('inbox/../x.jpg', 3, 'image/jpeg')).status).toBe(400)
  expect((await start('inbox/notes.txt', 3, 'text/plain')).status).toBe(415)
  expect((await start('inbox/cat.jpg', 3, 'image/jpeg')).status).toBe(201)
  expect((await start('inbox/huge.3mf', 65 * 1024 * 1024)).status).toBe(413)
  // The longest prefix decides, with its own limit.
  expect((await start('inbox/small/a.bin', 11)).status).toBe(413)
  const tooLong = await send(`${FILAMENT}/_hobwork/files/inbox/small/a.bin`, { method: 'PUT', headers, body: 'x'.repeat(11) })
  expect(tooLong.status).toBe(413)
  expect(existsSync(stored('inbox/small/a.bin'))).toBe(false)
})

test('uploads from the app need a session, the CSRF header and the app\'s own origin', async () => {
  const { headers } = session()
  const put = (extra: Record<string, string>) => send(`${FILAMENT}/_hobwork/files/inbox/cat.jpg`, { method: 'PUT', headers: { 'content-type': 'image/jpeg', ...extra }, body: 'meow' })
  expect((await put({})).status).toBe(401)
  expect((await put({ cookie: headers.cookie })).status).toBe(403)
  expect((await put({ ...headers, origin: SLEEP, 'sec-fetch-site': 'same-site' })).status).toBe(403)
  const ok = await put(headers)
  expect(ok.status, ok.body).toBe(201)
  expect(readFileSync(stored('inbox/cat.jpg'), 'utf8')).toBe('meow')
})

test('an upload token stores files through its own upload, from scripts', async () => {
  const token = rotateUploadToken(host, 'filament', 'inbox')
  expect(token).toMatch(/^hwu_/)
  const put = (url: string, auth: string, body = 'model') =>
    send(url, { method: 'PUT', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/octet-stream' }, body })
  const ok = await put(`${FILAMENT}/_hobwork/files/inbox/2026/benchy.3mf`, token)
  expect(ok.status, ok.body).toBe(201)
  expect(readFileSync(stored('inbox/2026/benchy.3mf'), 'utf8')).toBe('model')
  expect((await seen('benchy.3mf')).caller).toBeNull()

  // Not another upload's folder, not another hob, and a replaced token stops working.
  expect((await put(`${FILAMENT}/_hobwork/files/inbox/small/a.3mf`, token)).status).toBe(403)
  expect((await put(`${SLEEP}/_hobwork/files/inbox/a.3mf`, token)).status).toBe(401)
  rotateUploadToken(host, 'filament', 'inbox')
  expect((await put(`${FILAMENT}/_hobwork/files/inbox/b.3mf`, token)).status).toBe(401)
})

test('another person cannot continue an upload, and housekeeping drops unfinished ones', async () => {
  const { headers } = session()
  const json = { ...headers, 'content-type': 'application/json' }
  const start = await send(`${FILAMENT}/_hobwork/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ path: 'inbox/a.3mf', size: 10 }) })
  const { id } = JSON.parse(start.body)
  const other = session('ayse@example.com')
  expect((await send(`${FILAMENT}/_hobwork/uploads/${id}?offset=0`, { method: 'PUT', headers: other.headers, body: 'x' })).status).toBe(404)
  expect((await send(`${FILAMENT}/_hobwork/uploads/${id}?offset=0`, { method: 'PUT', headers, body: 'abc' })).status).toBe(200)

  const temp = dirname(projectFilesDir(host, 'filament'))
  expect(readdirSync(join(temp, 'files.tmp'))).toEqual([`upload-${id}`])
  await runHousekeeping(host, {}, Date.now() + UPLOAD_EXPIRY_MS + 1000)
  expect(readdirSync(join(temp, 'files.tmp'))).toEqual([])
  expect((await send(`${FILAMENT}/_hobwork/uploads/${id}`, { headers })).status).toBe(404)

  const cancelled = JSON.parse((await send(`${FILAMENT}/_hobwork/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ path: 'inbox/b.3mf', size: 10 }) })).body)
  expect((await send(`${FILAMENT}/_hobwork/uploads/${cancelled.id}`, { method: 'DELETE', headers })).status).toBe(204)
  expect(readdirSync(join(temp, 'files.tmp'))).toEqual([])
})
