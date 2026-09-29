import { afterEach, expect, test, vi } from 'vitest'
import { api, callRoute, RouteError, routeUrl } from '../src/browser.ts'

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
