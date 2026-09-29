import { expect, test } from 'vitest'
import { secretFiller, secretGuard } from './gondolin.ts'
import { requestHook, upstreamFetch } from './intercept.ts'

const upstream = async () => new Response('upstream')

test('only allowed requests to intercepted hosts reach the interceptor', async () => {
  const seen: string[] = []
  const hook = requestHook({
    internal: async () => new Response('internal'),
    intercept: {
      hosts: ['openrouter.ai', '*.openrouter.ai'],
      handle: async (request) => {
        seen.push(request.url)
        return new Response('intercepted')
      },
    },
    egress: ['openrouter.ai', 'example.com'],
    upstream,
  })!
  expect(await (await hook(new Request('https://hobwork.internal/v1/db')))!.text()).toBe('internal')
  expect(await (await hook(new Request('https://openrouter.ai/api/v1/chat/completions')))!.text()).toBe('intercepted')
  expect(await hook(new Request('https://example.com/'))).toBeUndefined()
  // Not in the egress allowlist, so Gondolin blocks and reports it.
  expect(await hook(new Request('https://eu.openrouter.ai/api/v1/chat/completions'))).toBeUndefined()
  expect(seen).toEqual(['https://openrouter.ai/api/v1/chat/completions'])
})

test('the secret filler swaps the guest placeholders only for the secret hosts', async () => {
  const fill = secretFiller(
    { OPENROUTER_API_KEY: { value: 'sk-real', hosts: ['openrouter.ai'] }, OTHER: { value: 'other-real', hosts: ['example.com'] } },
    { OPENROUTER_API_KEY: 'GONDOLIN_SECRET_aaaa', OTHER: 'GONDOLIN_SECRET_bbbb' },
  )
  const url = 'https://openrouter.ai/api/v1/chat/completions'
  const filled = await fill(new Request(url, { method: 'POST', headers: { authorization: 'Bearer GONDOLIN_SECRET_aaaa' }, body: '{}' }))
  expect(filled.headers.get('authorization')).toBe('Bearer sk-real')
  await expect(fill(new Request(url, { headers: { 'x-other': 'GONDOLIN_SECRET_bbbb' } }))).rejects.toThrow(
    'secret OTHER not allowed for host: openrouter.ai',
  )
})

test('without an internal handler or interceptor there is no hook', () => {
  expect(requestHook({ egress: [], upstream })).toBeUndefined()
})

test('upstream fills in secrets, drops connection headers and describes the decoded body', async () => {
  let sent: { url: string; init: RequestInit } | undefined
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent = { url, init }
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '5' },
    })
  }) as typeof fetch
  const send = upstreamFetch((request) => {
    const headers = new Headers(request.headers)
    headers.set('authorization', headers.get('authorization')!.replace('PLACEHOLDER', 'real-key'))
    return new Request(request, { headers })
  }, fetchImpl)
  const response = await send(
    new Request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer PLACEHOLDER', host: 'openrouter.ai', connection: 'keep-alive' },
      body: '{"model":"m"}',
    }),
  )
  expect(sent!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
  const headers = sent!.init.headers as Headers
  expect(headers.get('authorization')).toBe('Bearer real-key')
  expect(headers.has('host')).toBe(false)
  expect(headers.has('connection')).toBe(false)
  expect(Buffer.from(sent!.init.body as ArrayBuffer).toString()).toBe('{"model":"m"}')
  expect(sent!.init.redirect).toBe('manual')
  expect(response.headers.has('content-encoding')).toBe(false)
  expect(await response.json()).toEqual({ ok: true })
})

test('secrets are only sent over https, in Authorization and the headers the secret lists', () => {
  const guard = secretGuard(
    { API_KEY: { value: 'real', hosts: ['api.example.com'], headers: ['X-Api-Key'] }, PLAIN: { value: 'real2', hosts: ['api.example.com'] } },
    { API_KEY: 'GONDOLIN_SECRET_aaaa', PLAIN: 'GONDOLIN_SECRET_bbbb' },
  )
  const request = (headers: Record<string, string>, url = 'https://api.example.com/v1?key=GONDOLIN_SECRET_aaaa') =>
    new Request(url, { method: 'POST', headers, body: 'GONDOLIN_SECRET_aaaa' })
  expect(guard(request({ authorization: 'Bearer GONDOLIN_SECRET_aaaa' }))).toBeUndefined()
  expect(guard(request({ authorization: `Basic ${Buffer.from('user:GONDOLIN_SECRET_bbbb').toString('base64')}` }))).toBeUndefined()
  expect(guard(request({ 'x-api-key': 'GONDOLIN_SECRET_aaaa' }))).toBeUndefined()
  expect(guard(request({ 'content-type': 'application/json' }))).toBeUndefined()

  expect(guard(request({ 'x-token': 'GONDOLIN_SECRET_aaaa' }))).toBe(
    'Hobwork only sends API_KEY in the Authorization, X-Api-Key headers. Found it in the x-token header. People can add headers to the secret in Hobwork.',
  )
  expect(guard(request({ 'x-api-key': 'GONDOLIN_SECRET_bbbb' }))).toContain('Found it in the x-api-key header')
  expect(guard(request({ cookie: 'session=GONDOLIN_SECRET_bbbb' }))).toContain('Found it in the cookie header')
  expect(guard(request({ 'proxy-authorization': 'Bearer GONDOLIN_SECRET_bbbb' }))).toContain('proxy-authorization')

  const http = 'http://api.example.com/v1'
  expect(guard(request({ authorization: 'Bearer GONDOLIN_SECRET_aaaa' }, http))).toBe('Hobwork only sends API_KEY over https. Use an https:// URL.')
  expect(guard(request({ authorization: `Basic ${Buffer.from('u:GONDOLIN_SECRET_bbbb').toString('base64')}` }, http))).toContain('over https')
  expect(guard(request({ 'x-custom': 'nothing secret' }, http))).toBeUndefined()
})
