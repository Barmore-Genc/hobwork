import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Caller } from '../../../packages/sdk/src/people.ts'
import { UPLOAD_CHUNK_BYTES } from '../../../packages/sdk/src/uploads.ts'
import { createProject } from '../projects.ts'
import { projectFilesDir } from '../runtime/files.ts'
import { cleanFileName, type Completed } from '../runtime/uploads.ts'
import { createTestHost } from '../test-host.ts'
import { sendTo, signedIn, startTestApp } from '../test-web.ts'
import { createDevices, type Devices } from './devices.ts'
import type { Declarations, RouteAnswer } from './hob-surfaces.ts'
import { pairDevice } from './test-devices.ts'

vi.setConfig({ testTimeout: 30_000 })

type Routed = { project: string; request: { method: string; path: string; body?: unknown }; caller: Caller }

let host: ReturnType<typeof createTestHost>
let devices: Devices
let app: Awaited<ReturnType<typeof startTestApp>>
let routed: Routed[]
let uploaded: { project: string; done: Completed; caller: Caller }[]
let answers: (request: { method: string; path: string; body?: unknown }) => RouteAnswer
let token: string

const FILAMENT: Declarations = {
  intents: [],
  uploads: {
    inbox: { prefix: 'inbox/', maxBytes: 20 * 1024 * 1024, types: ['.3mf', 'image/*'] },
    private: { prefix: 'private/', maxBytes: 1024, types: [] },
  },
  share: [
    { id: 'queue', title: 'Add to the queue', route: '/share', accepts: { urls: true, text: false, files: ['model/3mf', '.3mf'] }, upload: 'inbox' },
    { id: 'note', title: 'Add a note', route: '/notes', accepts: { urls: false, text: true, files: [] } },
  ],
  appLinks: { include: ['/spool/*'], exclude: ['/spool/print'] },
  static: [{ prefix: '/photos', dir: 'photos', public: false }],
}

beforeEach(async () => {
  host = createTestHost()
  routed = []
  uploaded = []
  answers = () => ({ status: 200, body: { say: 'Added it to the queue.', open: '/queue/1' } })
  devices = createDevices({
    host,
    triggers: async () => ({}),
    callRoute: async (project, request, caller) => {
      routed.push({ project, request, caller })
      return answers(request)
    },
    declarations: async (project) => {
      if (project !== 'filament') throw new Error('never deployed')
      return FILAMENT
    },
    uploaded: async (project, done, caller) => {
      uploaded.push({ project, done, caller })
    },
  })
  await createProject(host, 'filament')
  await createProject(host, 'draft')
  app = await startTestApp(host, { devices, web: { allowlist: { emails: ['kaan@example.com', 'ayse@example.com'], subjects: [] } } })
  token = (await pairDevice(app.base, signedIn(host).cookie)).token
})

afterEach(async () => {
  await app.close()
  devices.close()
  host.dispose()
})

async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const res = await sendTo(app.base, `${app.base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  return { status: res.status, json: async () => JSON.parse(res.body) as unknown }
}

test('the hob list has share targets with their upload size, and link rules for every deployed hob', async () => {
  const res = await call('/api/devices/hobs')
  expect(await res.json()).toEqual({
    hobs: [
      {
        hob: 'filament',
        widget: false,
        intents: [],
        share: [
          { id: 'queue', title: 'Add to the queue', accepts: { urls: true, text: false, files: ['model/3mf', '.3mf'] }, maxBytes: 20 * 1024 * 1024 },
          { id: 'note', title: 'Add a note', accepts: { urls: false, text: true, files: [] } },
        ],
        appLinks: {
          include: ['/spool/*'],
          exclude: ['/api/*', '/_hobwork/*', '/theme/*', '/.well-known/*', '/photos', '/photos/*', '/spool/print'],
        },
      },
    ],
  })
})

test('a shared 3MF is uploaded in parts into the target folder, then the route runs with the file and the caller', async () => {
  const size = UPLOAD_CHUNK_BYTES + 1000
  const bytes = Buffer.alloc(size, 7)
  let res = await call('/api/devices/uploads', { body: { hob: 'filament', target: 'queue', name: 'Headphone stand (v2).3MF', size, type: 'model/3mf' } })
  expect(res.status).toBe(201)
  const started = (await res.json()) as { id: string; path: string; received: number; chunkBytes: number }
  expect(started).toMatchObject({ path: 'inbox/Headphone-stand-v2.3mf', received: 0, chunkBytes: UPLOAD_CHUNK_BYTES })
  const part = `/api/devices/uploads/filament/queue/${started.id}`

  const put = (offset: number, body: string) => sendTo(app.base, `${app.base}${part}?offset=${offset}`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body })
  expect(JSON.parse((await put(0, '\x07'.repeat(UPLOAD_CHUNK_BYTES))).body)).toMatchObject({ received: UPLOAD_CHUNK_BYTES })
  expect((await put(5, 'x')).status).toBe(409)
  expect(await (await call(part)).json()).toMatchObject({ received: UPLOAD_CHUNK_BYTES })
  const last = await put(UPLOAD_CHUNK_BYTES, '\x07'.repeat(size - UPLOAD_CHUNK_BYTES))
  expect(last.status).toBe(201)
  expect(JSON.parse(last.body)).toMatchObject({ done: true, file: { path: 'inbox/Headphone-stand-v2.3mf', size } })
  expect(readFileSync(join(projectFilesDir(host, 'filament'), 'inbox', 'Headphone-stand-v2.3mf')).equals(bytes)).toBe(true)
  expect(uploaded).toMatchObject([{ project: 'filament', done: { name: 'inbox' }, caller: { device: { name: 'kaan-iphone' } } }])

  // The same name again gets a free path rather than replacing the first file.
  res = await call('/api/devices/uploads', { body: { hob: 'filament', target: 'queue', name: 'Headphone stand (v2).3MF', size: 1 } })
  expect(await res.json()).toMatchObject({ path: 'inbox/Headphone-stand-v2-2.3mf' })

  res = await call('/api/devices/share', {
    body: {
      hob: 'filament',
      target: 'queue',
      url: 'https://makerworld.com/en/models/1052418',
      files: [{ path: 'inbox/Headphone-stand-v2.3mf', name: 'Headphone stand (v2).3MF', size: 1, contentType: 'model/3mf' }],
    },
  })
  expect(await res.json()).toEqual({ ok: true, say: 'Added it to the queue.' })
  expect(routed).toMatchObject([
    {
      project: 'filament',
      request: {
        method: 'POST',
        path: '/share',
        body: {
          target: 'queue',
          url: 'https://makerworld.com/en/models/1052418',
          files: [{ path: 'inbox/Headphone-stand-v2.3mf', name: 'Headphone stand (v2).3MF', size, contentType: 'model/3mf' }],
        },
      },
      caller: { device: { name: 'kaan-iphone', platform: 'ios' } },
    },
  ])
})

test('uploads are refused for targets without files, other types, sizes over the limit and other folders', async () => {
  const start = (body: Record<string, unknown>) => call('/api/devices/uploads', { body: { hob: 'filament', target: 'queue', name: 'a.3mf', size: 10, ...body } })
  expect((await start({ target: 'note' })).status).toBe(400)
  expect((await start({ target: 'nope' })).status).toBe(404)
  expect((await start({ hob: 'draft' })).status).toBe(404)
  expect((await start({ name: 'cat.png', type: 'image/png' })).status).toBe(415)
  expect((await start({ size: 21 * 1024 * 1024 })).status).toBe(413)
  expect((await start({ name: '' })).status).toBe(400)

  const share = async (body: Record<string, unknown>) => (await call('/api/devices/share', { body: { hob: 'filament', target: 'queue', ...body } })).json()
  expect(await share({ files: [{ path: 'private/secret.txt' }] })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  expect(await share({ files: [{ path: 'inbox/missing.3mf' }] })).toMatchObject({ ok: false, error: { message: 'inbox/missing.3mf has not been uploaded' } })
  expect(await share({ text: 'hello' })).toMatchObject({ ok: false, error: { code: 'not_accepted' } })
  expect(await share({ url: 'javascript:alert(1)' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  expect(await share({})).toMatchObject({ ok: false, error: { message: 'Share a link, text or files' } })
  expect(routed).toEqual([])

  expect(await share({ target: 'note', text: 'Buy PETG' })).toEqual({ ok: true, say: 'Added it to the queue.' })
  expect(routed[0]!.request).toEqual({ method: 'POST', path: '/notes', body: { target: 'note', text: 'Buy PETG', files: [] } })
  answers = () => ({ status: 500, body: {} })
  expect(await share({ url: 'https://example.com/' })).toMatchObject({ ok: false, error: { code: 'route_failed' } })
  expect((await fetch(`${app.base}/api/devices/share`, { method: 'POST', body: '{}' })).status).toBe(401)
})

test('a device can cancel its upload, and another person cannot continue it', async () => {
  const res = await call('/api/devices/uploads', { body: { hob: 'filament', target: 'queue', name: 'a.3mf', size: 10 } })
  const { id } = (await res.json()) as { id: string }
  const other = await pairDevice(app.base, signedIn(host, 'ayse@example.com').cookie, { deviceName: "Ayşe's iPhone", name: 'ayse-iphone' })
  const theirs = await fetch(`${app.base}/api/devices/uploads/filament/queue/${id}`, { headers: { authorization: `Bearer ${other.token}` } })
  expect(theirs.status).toBe(404)
  expect((await call(`/api/devices/uploads/filament/queue/${id}`, { method: 'DELETE' })).status).toBe(204)
  expect((await call(`/api/devices/uploads/filament/queue/${id}`)).status).toBe(404)
})

test('file names from other apps become one safe path segment', () => {
  expect(cleanFileName('Headphone stand (v2).3MF')).toBe('Headphone-stand-v2.3mf')
  expect(cleanFileName('Café crème.jpg')).toBe('Cafe-creme.jpg')
  expect(cleanFileName('../../etc/passwd')).toBe('passwd')
  expect(cleanFileName('.hidden')).toBe('shared.hidden')
  expect(cleanFileName('notes')).toBe('notes')
  expect(cleanFileName('写真.png')).toBe('shared.png')
  expect(cleanFileName('a'.repeat(300))).toHaveLength(120)
})
