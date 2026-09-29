import { randomBytes } from 'node:crypto'
import { chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProject } from './projects.ts'
import { createSecretStore, loadSecretKey, SECRET_KEY_FILE, type SecretStore } from './secrets.ts'
import { createTestHost } from './test-host.ts'

let host: ReturnType<typeof createTestHost>
let store: SecretStore
const key = randomBytes(32)

beforeEach(async () => {
  host = createTestHost()
  store = createSecretStore(host, key)
  await createProject(host, 'filament')
  await createProject(host, 'alarms')
})

afterEach(() => host.dispose())

test('generates a key file readable only by the host user and reuses it', () => {
  const first = loadSecretKey(host.dataDir)
  const path = join(host.dataDir, SECRET_KEY_FILE)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(loadSecretKey(host.dataDir)).toEqual(first)
  expect(first).toHaveLength(32)
  chmodSync(path, 0o644)
  expect(() => loadSecretKey(host.dataDir)).toThrow('readable by other users')
})

test('HOBWORK_SECRET_KEY takes hex or base64 and must be 32 bytes', () => {
  const raw = randomBytes(32)
  expect(loadSecretKey(host.dataDir, raw.toString('hex'))).toEqual(raw)
  expect(loadSecretKey(host.dataDir, raw.toString('base64'))).toEqual(raw)
  expect(() => loadSecretKey(host.dataDir, 'short')).toThrow('must be 32 bytes')
})

test('values are encrypted at rest and only come out for the sandbox', () => {
  store.set({ project: 'filament', name: 'SPOOL_API_KEY', value: 'plain-text-value', hosts: ['API.Spools.example.'] })
  const row = host.db.prepare('SELECT value, hosts FROM secrets').get() as { value: Uint8Array; hosts: string }
  expect(Buffer.from(row.value).includes('plain-text-value')).toBe(false)
  expect(JSON.parse(row.hosts)).toEqual(['api.spools.example'])
  expect(JSON.stringify(store.list('filament'))).not.toContain('plain-text-value')
  expect(store.forSandbox('filament')).toEqual({ SPOOL_API_KEY: { value: 'plain-text-value', hosts: ['api.spools.example'] } })
  expect(() => createSecretStore(host, randomBytes(32)).forSandbox('filament')).toThrow('cannot be decrypted')
})

test('a ciphertext copied to another project or name does not decrypt', () => {
  store.set({ project: 'filament', name: 'A_KEY', value: 'one', hosts: ['a.example'] })
  store.set({ project: 'alarms', name: 'A_KEY', value: 'two', hosts: ['a.example'] })
  host.db.exec(`UPDATE secrets SET value = (SELECT value FROM secrets WHERE project_id = (SELECT id FROM projects WHERE name = 'filament'))`)
  expect(store.forSandbox('filament').A_KEY?.value).toBe('one')
  expect(() => store.forSandbox('alarms')).toThrow('cannot be decrypted')
})

test('project secrets override global ones of the same name', () => {
  store.set({ name: 'SHARED', value: 'global', hosts: ['g.example'] })
  store.set({ name: 'ONLY_GLOBAL', value: 'g2', hosts: ['*.g2.example'] })
  store.set({ project: 'filament', name: 'SHARED', value: 'own', hosts: ['own.example'] })
  expect(store.effective('filament').map((s) => [s.name, s.scope])).toEqual([
    ['ONLY_GLOBAL', 'global'],
    ['SHARED', 'project'],
  ])
  expect(store.forSandbox('filament').SHARED?.value).toBe('own')
  expect(store.forSandbox('alarms').SHARED?.value).toBe('global')
  expect(store.hosts('filament')).toEqual(['*.g2.example', 'own.example'])
  expect(store.list().map((s) => s.name)).toEqual(['ONLY_GLOBAL', 'SHARED'])
})

test('updates keep the value or the hosts when left out, and change the fingerprint', () => {
  expect(store.set({ project: 'filament', name: 'TOKEN', value: 'v1', hosts: ['a.example'] })).toEqual({ created: true })
  const before = store.fingerprint('filament')
  expect(store.set({ project: 'filament', name: 'TOKEN', hosts: ['b.example'] })).toEqual({ created: false })
  expect(store.forSandbox('filament').TOKEN).toEqual({ value: 'v1', hosts: ['b.example'] })
  const afterHosts = store.fingerprint('filament')
  expect(afterHosts).not.toBe(before)
  store.set({ project: 'filament', name: 'TOKEN', value: 'v2' })
  expect(store.forSandbox('filament').TOKEN?.value).toBe('v2')
  expect(store.remove('filament', 'TOKEN')).toBe(true)
  expect(store.remove('filament', 'TOKEN')).toBe(false)
  expect(store.fingerprint('filament')).not.toBe(afterHosts)
  expect(store.fingerprint('alarms')).toBe(store.fingerprint('filament'))
})

test.each([
  [{ name: 'lower', value: 'x', hosts: ['a.example'] }, 'capital letters'],
  [{ name: 'PATH', value: 'x', hosts: ['a.example'] }, 'reserved'],
  [{ name: 'HOBWORK_X', value: 'x', hosts: ['a.example'] }, 'reserved'],
  [{ name: 'NEW', value: 'x' }, 'needs a value and at least one host'],
  [{ name: 'NEW', value: 'x', hosts: [] }, 'at least one host'],
  [{ name: 'NEW', value: 'x', hosts: ['*'] }, 'is not a host name'],
  [{ name: 'NEW', value: 'x', hosts: ['hobwork.internal'] }, 'is not a host name'],
  [{ name: 'NEW', value: 'x', hosts: ['https://a.example/path'] }, 'is not a host name'],
  [{ name: 'NEW', value: '', hosts: ['a.example'] }, 'must not be empty'],
  [{ name: 'NEW', value: 'two\nlines', hosts: ['a.example'] }, 'single line'],
])('refuses %o', (input, message) => {
  expect(() => store.set({ project: 'filament', ...input })).toThrow(message)
})
