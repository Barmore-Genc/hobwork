import { expect, test } from 'vitest'
import { secretFiller } from './gondolin.ts'
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
