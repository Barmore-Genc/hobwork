import { expect, test } from 'vitest'
import { parseProjectConfig } from './config.ts'

test('reads a hobwork.json with comments and trailing commas', () => {
  const config = parseProjectConfig('{\n  // Every hour.\n  "crons": { "a": { "schedule": "0 * * * *", "handler": "src/a.ts" } },\n  "idleTimeout": "5m",\n}')
  expect(config.crons).toEqual({ a: { schedule: '0 * * * *', handler: 'src/a.ts' } })
  expect(config.idleTimeoutMs).toBe(5 * 60_000)
})
