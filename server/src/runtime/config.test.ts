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
