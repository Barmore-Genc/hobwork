import { expect, test } from 'vitest'
import { validateHobworkJson } from '../pipeline/validate.ts'
import { contentSecurityPolicy } from './csp.ts'

const csp = (value: unknown) => validateHobworkJson(JSON.stringify({ csp: value }))

test('the default policy allows no inline scripts, plugins or foreign framing', () => {
  const policy = contentSecurityPolicy('https://hobwork.example.com')
  expect(policy).toContain("script-src 'self';")
  expect(policy).toContain("object-src 'none'")
  expect(policy).toContain("base-uri 'self'")
  expect(policy).toContain('frame-ancestors https://hobwork.example.com')
})

test('sources are added per directive, and unlisted or unsafe values are dropped', () => {
  const policy = contentSecurityPolicy('https://h.example', {
    'script-src': ['https://cdn.example.com', "'unsafe-eval'", 'data:', '*', 'https:', 'https://a.example; script-src *'],
    'frame-ancestors': ['*'],
    'base-uri': ['*'],
    'img-src': ['https://*.img.example', 'data:'],
    __proto__: ['https://x.example'],
  })
  expect(policy).toContain("script-src 'self' https://cdn.example.com 'unsafe-eval';")
  expect(policy).toContain("img-src 'self' data: blob: https://*.img.example;")
  expect(policy.match(/frame-ancestors/g)).toHaveLength(1)
  expect(policy.match(/base-uri/g)).toHaveLength(1)
  expect(policy).not.toContain('*;')
  expect(policy).not.toContain('x.example')
})

test('hobwork.json accepts plain origins and rejects everything else', () => {
  expect(
    csp({ 'script-src': ['https://cdn.example.com', "'unsafe-inline'"], 'connect-src': ['wss://a.example.com:8080', 'https://*.b.example', 'data:'] }),
  ).toEqual([])
  expect(csp({ 'script-src': ['*'] })).not.toEqual([])
  expect(csp({ 'script-src': ['https:'] })).not.toEqual([])
  expect(csp({ 'script-src': ['data:'] })).not.toEqual([])
  expect(csp({ 'script-src': ["'nonce-abc'"] })).not.toEqual([])
  expect(csp({ 'connect-src': ["'unsafe-inline'"] })).not.toEqual([])
  expect(csp({ 'connect-src': ['https://a.example; script-src *'] })).not.toEqual([])
  expect(csp({ 'frame-ancestors': ['*'] })).not.toEqual([])
  expect(csp({ 'base-uri': ["'self'"] })).not.toEqual([])
  expect(csp({ 'default-src': ['https://a.example'] })).not.toEqual([])
  expect(csp({ 'form-action': ['blob:'] })).not.toEqual([])
  expect(csp(['https://a.example'])).not.toEqual([])
})
