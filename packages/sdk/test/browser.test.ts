import { afterEach, expect, test, vi } from 'vitest'
import { api, callRoute, files, RouteError, routeUrl } from '../src/browser.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(response: Response) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => response)
  vi.stubGlobal('fetch', fetch)
  return fetch
}

test('routes resolve under /api/ on the app origin', () => {
  expect(routeUrl('spools/42')).toBe('/api/spools/42')
  expect(routeUrl('/spools?full=1')).toBe('/api/spools?full=1')
})

test('every call sends the session and the CSRF header', async () => {
  const fetch = stubFetch(new Response(null, { status: 204 }))
  await callRoute('spools', { method: 'DELETE', headers: { accept: 'text/plain' } })
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toBe('/api/spools')
  expect(init.credentials).toBe('same-origin')
  const headers = new Headers(init.headers)
  expect(headers.get('x-hobwork-csrf')).toBe('1')
  expect(headers.get('accept')).toBe('text/plain')
})

test('api sends and parses JSON', async () => {
  const fetch = stubFetch(Response.json({ id: 3 }, { status: 201 }))
  expect(await api.post('spools', { color: 'red' })).toEqual({ id: 3 })
  const [, init] = fetch.mock.calls[0]!
  expect(init.method).toBe('POST')
  expect(init.body).toBe('{"color":"red"}')
  expect(new Headers(init.headers).get('content-type')).toBe('application/json')

  stubFetch(new Response(null, { status: 204 }))
  expect(await api.delete('spools/3')).toBeUndefined()
  stubFetch(new Response('plain', { headers: { 'content-type': 'text/plain' } }))
  expect(await api.get('hello')).toBe('plain')
})

test('error statuses throw a RouteError with the message from the body', async () => {
  stubFetch(Response.json({ error: 'The handler failed', invocation: 12 }, { status: 500 }))
  const err = await api.get('spools').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(RouteError)
  expect(err).toMatchObject({ status: 500, message: 'The handler failed', body: { invocation: 12 } })

  stubFetch(new Response('nope', { status: 404 }))
  await expect(api.get('missing')).rejects.toThrow('GET /api/missing answered 404')
})

// Speaks the host's upload protocol, in memory, with 4-byte parts.
function fakeUploads(options: { dropPart?: number } = {}) {
  const stored: { path: string; size: number; type?: string; bytes: number[] } = { path: '', size: 0, bytes: [] }
  const calls: string[] = []
  let parts = 0
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push(`${method} ${url}`)
    expect(new Headers(init.headers).get('x-hobwork-csrf')).toBe('1')
    const status = () => ({ id: 'u1', path: stored.path, size: stored.size, received: stored.bytes.length, chunkBytes: 4 })
    if (method === 'POST') {
      Object.assign(stored, JSON.parse(init.body as string))
      return Response.json(status(), { status: 201 })
    }
    if (method === 'GET') return Response.json(status())
    const offset = Number(new URL(url, 'http://app').searchParams.get('offset'))
    if (offset !== stored.bytes.length) return Response.json({ error: 'wrong offset' }, { status: 409 })
    stored.bytes.push(...new Uint8Array(await (init.body as Blob).arrayBuffer()))
    // The part arrives, but its answer is lost.
    if (++parts === options.dropPart) throw new TypeError('Failed to fetch')
    if (stored.bytes.length < stored.size) return Response.json(status())
    return Response.json({ done: true, file: { path: stored.path, size: stored.size, modified: '2026-10-09T10:00:00.000Z' } }, { status: 201 })
  })
  vi.stubGlobal('fetch', fetch)
  return { stored, calls }
}

test('files.upload sends the file in parts and reports progress', async () => {
  const { stored, calls } = fakeUploads()
  const progress: number[] = []
  const file = await files.upload('inbox/benchy.3mf', new Blob(['0123456789'], { type: 'model/3mf' }), {
    onProgress: ({ loaded, total }) => progress.push(loaded / total),
  })
  expect(file).toEqual({ path: 'inbox/benchy.3mf', size: 10, modified: '2026-10-09T10:00:00.000Z' })
  expect(stored).toMatchObject({ path: 'inbox/benchy.3mf', size: 10, type: 'model/3mf' })
  expect(String.fromCharCode(...stored.bytes)).toBe('0123456789')
  expect(calls).toEqual([
    'POST /_hobwork/uploads',
    'PUT /_hobwork/uploads/u1?offset=0',
    'PUT /_hobwork/uploads/u1?offset=4',
    'PUT /_hobwork/uploads/u1?offset=8',
  ])
  expect(progress).toEqual([0, 0.4, 0.8, 1])
})

test('files.upload goes on from where the host stands after a lost answer', async () => {
  const { stored, calls } = fakeUploads({ dropPart: 2 })
  await files.upload('inbox/a.bin', new Blob(['0123456789']))
  expect(String.fromCharCode(...stored.bytes)).toBe('0123456789')
  expect(calls).toContain('GET /_hobwork/uploads/u1')
  expect(calls.at(-1)).toBe('PUT /_hobwork/uploads/u1?offset=8')
})

test('files.upload throws the host\'s refusal', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: 'This upload takes only .3mf files' }, { status: 415 }))
  await expect(files.upload('inbox/a.txt', new Blob(['x']))).rejects.toMatchObject({ status: 415, message: 'This upload takes only .3mf files' })
})
