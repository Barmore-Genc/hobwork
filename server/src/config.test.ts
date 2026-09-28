import { isAbsolute } from 'node:path'
import { expect, test } from 'vitest'
import { loadConfig } from './config.ts'

test('defaults', () => {
  const config = loadConfig({})
  expect(config.port).toBe(7420)
  expect(isAbsolute(config.dataDir)).toBe(true)
  expect(config.dataDir.endsWith('/data')).toBe(true)
})

test('reads env overrides', () => {
  const config = loadConfig({ HOBWORK_PORT: '8000', HOBWORK_DATA_DIR: '/tmp/x' })
  expect(config).toMatchObject({ port: 8000, dataDir: '/tmp/x' })
})

test('rejects an invalid port', () => {
  expect(() => loadConfig({ HOBWORK_PORT: 'abc' })).toThrow('HOBWORK_PORT')
})
