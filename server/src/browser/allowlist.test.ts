import { expect, test } from 'vitest'
import { isLoopbackHost, navigationProblem, parseBrowserSites } from './allowlist.ts'

const sites = parseBrowserSites(['shop.example.com', '*.example.org', 'nas.lan:8443'])

function problem(url: string, list = sites): string | undefined {
  return navigationProblem(new URL(url), list)
}

test('only https pages open', () => {
  expect(problem('http://shop.example.com/cart')).toMatch(/only https/)
  expect(problem('file:///etc/passwd')).toMatch(/only https/)
  expect(problem('data:text/html,hi')).toMatch(/only https/)
  expect(problem('https://shop.example.com/cart')).toBeUndefined()
})

test('a declared host, a subdomain pattern, and a port', () => {
  expect(problem('https://shop.example.com/orders/42?full=1')).toBeUndefined()
  expect(problem('https://www.example.org/')).toBeUndefined()
  expect(problem('https://a.b.example.org/')).toBeUndefined()
  // `*.example.org` does not match the domain itself, as in egress.
  expect(problem('https://example.org/')).toMatch(/is not one of this hob's browser sites/)
  expect(problem('https://evil.com/')).toMatch(/is not one of this hob's browser sites/)
  expect(problem('https://nas.lan:8443/admin')).toBeUndefined()
  expect(problem('https://nas.lan/admin')).toMatch(/is not one of this hob's browser sites/)
  expect(problem('https://nas.lan:5000/admin')).toMatch(/is not one of this hob's browser sites/)
})

test('the message says where the site goes', () => {
  expect(problem('https://nas.lan:5000/admin')).toContain('"nas.lan:5000"')
  expect(problem('https://evil.com/')).toContain('browser.sites')
})

test('loopback is refused even when declared', () => {
  const local = parseBrowserSites(['localhost', '127.0.0.1', '*.localhost', '[::1]'])
  expect(problem('https://localhost:7420/', local)).toMatch(/loopback/)
  expect(problem('https://127.0.0.1/', local)).toMatch(/loopback/)
  expect(problem('https://app.localhost/', local)).toMatch(/loopback/)
  expect(problem('https://[::1]/', local)).toMatch(/loopback/)
})

test('what counts as loopback', () => {
  expect(isLoopbackHost('localhost')).toBe(true)
  expect(isLoopbackHost('foo.localhost')).toBe(true)
  expect(isLoopbackHost('127.0.0.1')).toBe(true)
  expect(isLoopbackHost('127.1.2.3')).toBe(true)
  expect(isLoopbackHost('[::1]')).toBe(true)
  expect(isLoopbackHost('0.0.0.0')).toBe(true)
  expect(isLoopbackHost('example.com')).toBe(false)
  expect(isLoopbackHost('10.0.0.1')).toBe(false)
  expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(false)
})

test('entries the host cannot parse are dropped, and then nothing opens', () => {
  const bad = parseBrowserSites(['not a host', '', '*.example.com'])
  expect(bad).toEqual([{ host: '*.example.com' }])
  expect(problem('https://example.com/', [])).toMatch(/is not one of/)
  expect(parseBrowserSites(undefined)).toEqual([])
})
