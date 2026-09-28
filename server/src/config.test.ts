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

test('Home Assistant is optional', () => {
  expect(loadConfig({}).homeAssistant).toBeUndefined()
  expect(
    loadConfig({ HOBWORK_HA_URL: 'http://ha.local:8123', HOBWORK_HA_TOKEN: 'secret' }).homeAssistant,
  ).toEqual({ url: 'http://ha.local:8123', token: 'secret' })
})

test('rejects incomplete or invalid Home Assistant settings', () => {
  expect(() => loadConfig({ HOBWORK_HA_URL: 'http://ha.local:8123' })).toThrow('set together')
  expect(() => loadConfig({ HOBWORK_HA_URL: 'ha.local', HOBWORK_HA_TOKEN: 'x' })).toThrow('HOBWORK_HA_URL')
  expect(() => loadConfig({ HOBWORK_HA_URL: 'ftp://ha.local', HOBWORK_HA_TOKEN: 'x' })).toThrow('http')
})

test('workspace idle timeout', () => {
  expect(loadConfig({}).workspaceIdleTimeoutMs).toBe(30 * 60_000)
  expect(loadConfig({ HOBWORK_WORKSPACE_IDLE_MINUTES: '0.5' }).workspaceIdleTimeoutMs).toBe(30_000)
  expect(() => loadConfig({ HOBWORK_WORKSPACE_IDLE_MINUTES: '0' })).toThrow('HOBWORK_WORKSPACE_IDLE_MINUTES')
})
