import { expect, test } from 'vitest'
import { hostMatches } from './egress.ts'

test.each([
  ['api.example.com', ['api.example.com'], true],
  ['API.Example.com', ['api.example.com'], true],
  ['a.api.example.com', ['*.example.com'], true],
  ['example.com', ['*.example.com'], false],
  ['evil-example.com', ['example.com'], false],
  ['example.com.evil.net', ['example.com'], false],
  ['anything.test', ['*'], true],
  ['anything.test', [], false],
  ['anything.test', [' '], false],
])('%s against %o is %s', (hostname, patterns, expected) => {
  expect(hostMatches(hostname, patterns)).toBe(expected)
})
