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

test('SSH gateway port', () => {
  expect(loadConfig({}).sshPort).toBe(2222)
  expect(loadConfig({ HOBWORK_SSH_PORT: '2022' }).sshPort).toBe(2022)
  expect(loadConfig({ HOBWORK_SSH_PORT: 'off' }).sshPort).toBeUndefined()
  expect(() => loadConfig({ HOBWORK_SSH_PORT: '99999' })).toThrow('HOBWORK_SSH_PORT')
})

test('Home Assistant is optional', () => {
  expect(loadConfig({}).homeAssistant).toBeUndefined()
  expect(
    loadConfig({ HOBWORK_HA_URL: 'http://ha.local:8123', HOBWORK_HA_TOKEN: 'secret' }).homeAssistant,
  ).toEqual({ url: 'http://ha.local:8123', token: 'secret' })
})

test('public URL defaults to localhost and must be an origin', () => {
  expect(loadConfig({ HOBWORK_PORT: '8000' }).publicUrl).toBe('http://localhost:8000')
  expect(loadConfig({ HOBWORK_PUBLIC_URL: 'https://hob.example.com/' }).publicUrl).toBe('https://hob.example.com')
  expect(() => loadConfig({ HOBWORK_PUBLIC_URL: 'https://hob.example.com/app' })).toThrow('origin')
  expect(() => loadConfig({ HOBWORK_PUBLIC_URL: 'hob.example.com' })).toThrow('HOBWORK_PUBLIC_URL')
})

test('an http public URL must be loopback', () => {
  for (const url of ['http://localhost:7420', 'http://hobwork.localhost:5173', 'http://127.0.0.1:7420', 'http://127.1.2.3', 'http://[::1]:7420']) {
    expect(loadConfig({ HOBWORK_PUBLIC_URL: url }).publicUrl).toBe(new URL(url).origin)
  }
  for (const url of ['http://hob.example.com', 'http://192.168.1.5:7420', 'http://10.0.0.2', 'http://localhost.example.com', 'http://[2001:db8::1]']) {
    expect(() => loadConfig({ HOBWORK_PUBLIC_URL: url })).toThrow(/HOBWORK_PUBLIC_URL must use https unless it is a loopback address/)
  }
  expect(() =>
    loadConfig({ HOBWORK_PUBLIC_URL: 'https://hob.example.com', HOBWORK_APPS_URL: 'http://apps.hob.example.com' }),
  ).toThrow('HOBWORK_APPS_URL must use https')
})

test('OIDC settings and allowlist', () => {
  expect(loadConfig({}).oidc).toBeUndefined()
  expect(loadConfig({}).allowlist).toEqual({ emails: [], subjects: [] })
  expect(() => loadConfig({ HOBWORK_OIDC_ISSUER: 'https://id.example.com' })).toThrow('set together')
  const config = loadConfig({
    HOBWORK_OIDC_ISSUER: 'https://id.example.com',
    HOBWORK_OIDC_CLIENT_ID: 'hobwork',
    HOBWORK_OIDC_CLIENT_SECRET: 's3cret',
    HOBWORK_ALLOWED_USERS: 'Kaan@Example.com, sub:abc-123 ,',
  })
  expect(config.oidc).toEqual({
    issuer: 'https://id.example.com',
    clientId: 'hobwork',
    clientSecret: 's3cret',
    name: 'Pocket ID',
  })
  expect(config.allowlist).toEqual({ emails: ['kaan@example.com'], subjects: ['abc-123'] })
  expect(loadConfig({ HOBWORK_ALLOWED_USERS: ' * ' }).allowlist).toEqual({ emails: [], subjects: [], everyone: true })
  expect(() => loadConfig({ HOBWORK_ALLOWED_USERS: '*, kaan@example.com' })).toThrow('either *')
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

test('apps URL defaults to apps.<public host> and must be an origin with a domain', () => {
  expect(loadConfig({ HOBWORK_PUBLIC_URL: 'https://hob.example.com' }).appsUrl).toBe('https://apps.hob.example.com')
  expect(loadConfig({ HOBWORK_PUBLIC_URL: 'http://hobwork.localhost:5173' }).appsUrl).toBe('http://apps.hobwork.localhost:5173')
  expect(
    loadConfig({ HOBWORK_PUBLIC_URL: 'http://hobwork.localhost:5173', HOBWORK_APPS_URL: 'http://apps.hobwork.localhost:7420/' })
      .appsUrl,
  ).toBe('http://apps.hobwork.localhost:7420')
  expect(() => loadConfig({ HOBWORK_APPS_URL: 'https://apps.example.com/x' })).toThrow('origin')
  expect(() => loadConfig({ HOBWORK_APPS_URL: 'http://127.0.0.1:7420' })).toThrow('domain name')
  expect(() => loadConfig({ HOBWORK_APPS_URL: 'http://localhost:7420' })).toThrow('domain name')
  expect(() => loadConfig({ HOBWORK_PUBLIC_URL: 'https://a.example.com', HOBWORK_APPS_URL: 'https://a.example.com' })).toThrow(
    'must differ',
  )
})

test('the Apple app ID for universal links has a default and must be <team ID>.<bundle ID>', () => {
  expect(loadConfig({}).appleAppId).toBe('63QQLP356Q.dev.bgenc.hobwork')
  expect(loadConfig({ HOBWORK_APPLE_APP_ID: 'ABCDE12345.example.app' }).appleAppId).toBe('ABCDE12345.example.app')
  expect(() => loadConfig({ HOBWORK_APPLE_APP_ID: 'dev.bgenc.hobwork' })).toThrow('<team ID>.<bundle ID>')
})
