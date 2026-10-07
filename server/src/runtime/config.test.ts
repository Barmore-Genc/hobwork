import { expect, test } from 'vitest'
import { MAX_IDLE_TIMEOUT_MS, parseProjectConfig } from './config.ts'

test('reads a hobwork.json with comments and trailing commas', () => {
  const config = parseProjectConfig('{\n  // Every hour.\n  "crons": { "a": { "schedule": "0 * * * *", "handler": "src/a.ts" } },\n  "idleTimeout": "5m",\n}')
  expect(config.crons).toEqual({ a: { schedule: '0 * * * *', handler: 'src/a.ts' } })
  expect(config.idleTimeoutMs).toBe(5 * 60_000)
})

test('reads requested resources', () => {
  expect(parseProjectConfig('{}').resources).toEqual({})
  expect(parseProjectConfig('{ "resources": { "runtime": { "memoryMb": 256 } } }').resources).toEqual({
    runtime: { memoryMb: 256 },
  })
})

test('no other app may send requests to an app unless crossAppRequests lists it', () => {
  expect(parseProjectConfig('{}').crossAppRequests).toEqual([])
  expect(parseProjectConfig('{ "crossAppRequests": ["sleep"] }').crossAppRequests).toEqual(['sleep'])
})

test('clamps idleTimeout below the largest setTimeout delay', () => {
  expect(parseProjectConfig('{ "idleTimeout": "365d" }').idleTimeoutMs).toBe(MAX_IDLE_TIMEOUT_MS)
  expect(parseProjectConfig('{ "idleTimeout": "99999999999999999999ms" }').idleTimeoutMs).toBe(MAX_IDLE_TIMEOUT_MS)
})

test('reads static mounts, longest prefix first, and drops any that could serve something else', () => {
  expect(parseProjectConfig('{}').static).toEqual([])
  const mounts = parseProjectConfig(
    JSON.stringify({
      static: {
        '/photos': { dir: 'photos' },
        '/photos/shared': { dir: 'shared', public: true },
        '/api/files': { dir: 'x' },
        '/_hobwork/x': { dir: 'x' },
        '/theme': { dir: 'x' },
        '/up': { dir: '../etc' },
        '/.git': { dir: 'x' },
        'nope': { dir: 'x' },
      },
    }),
  ).static
  expect(mounts).toEqual([
    { prefix: '/photos/shared', dir: 'shared', public: true },
    { prefix: '/photos', dir: 'photos', public: false },
  ])
})
