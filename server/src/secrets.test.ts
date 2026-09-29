import { createCipheriv, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentToken } from './agents.ts'
import { migrationsDir, openDb } from './db.ts'
import { migrate } from './migrate.ts'
import { createProject } from './projects.ts'
import { queryLogs } from './runtime/logs.ts'
import { createSecretStore, loadSecretKey, SECRET_KEY_FILE, type Actor, type SecretStore } from './secrets.ts'
import { createTestHost } from './test-host.ts'

let host: ReturnType<typeof createTestHost>
let store: SecretStore
const key = randomBytes(32)
const HOST: Actor = { kind: 'host' }

beforeEach(async () => {
  host = createTestHost()
  store = createSecretStore(host, key)
  await createProject(host, 'filament')
  await createProject(host, 'alarms')
})

afterEach(() => host.dispose())

function events(project: string): string[] {
  return queryLogs(host, { project, eventsOnly: true, limit: 100 }).map((line) => line.message)
}

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
  store.create(
    { name: 'Spool key', value: 'plain-text-value', hosts: ['API.Spools.example.'], assign: { project: 'filament', envName: 'SPOOL_API_KEY' } },
    HOST,
  )
  const row = host.db.prepare('SELECT value, hosts FROM secrets').get() as { value: Uint8Array; hosts: string }
  expect(Buffer.from(row.value).includes('plain-text-value')).toBe(false)
  expect(JSON.parse(row.hosts)).toEqual(['api.spools.example'])
  expect(JSON.stringify([store.list(), store.assigned('filament')])).not.toContain('plain-text-value')
  expect(store.forSandbox('filament')).toEqual({ SPOOL_API_KEY: { value: 'plain-text-value', hosts: ['api.spools.example'] } })
  expect(store.forSandbox('alarms')).toEqual({})
  expect(() => createSecretStore(host, randomBytes(32)).forSandbox('filament')).toThrow('cannot be decrypted')
})

test('a ciphertext copied to another secret does not decrypt, and renaming keeps the value', () => {
  const one = store.create({ name: 'One', value: 'one', hosts: ['a.example'], assign: { project: 'filament', envName: 'A_KEY' } }, HOST)
  store.create({ name: 'Two', value: 'two', hosts: ['a.example'], assign: { project: 'alarms', envName: 'A_KEY' } }, HOST)
  store.update(one.id, { name: 'One renamed' }, HOST)
  expect(store.forSandbox('filament').A_KEY?.value).toBe('one')
  host.db.exec(`UPDATE secrets SET value = (SELECT value FROM secrets WHERE name = 'One renamed')`)
  expect(store.forSandbox('filament').A_KEY?.value).toBe('one')
  expect(() => store.forSandbox('alarms')).toThrow('cannot be decrypted')
})

test('one secret can be assigned to several projects under different env names', () => {
  const secret = store.create({ name: 'Spoolman API key', value: 'v', hosts: ['spoolman.example'] }, HOST)
  expect(store.forSandbox('filament')).toEqual({})
  store.assign('filament', 'Spoolman API key', 'SPOOLMAN_TOKEN', HOST)
  store.assign('alarms', secret.id, 'API_KEY', HOST)
  expect(store.forSandbox('filament')).toEqual({ SPOOLMAN_TOKEN: { value: 'v', hosts: ['spoolman.example'] } })
  expect(store.forSandbox('alarms')).toEqual({ API_KEY: { value: 'v', hosts: ['spoolman.example'] } })
  expect(store.get(secret.id)?.assignments.map((a) => [a.project, a.envName])).toEqual([
    ['alarms', 'API_KEY'],
    ['filament', 'SPOOLMAN_TOKEN'],
  ])
  expect(store.list('filament').map((s) => s.name)).toEqual(['Spoolman API key'])
})

test('a project cannot have two secrets under one env name, or one secret twice', () => {
  const a = store.create({ name: 'A', value: 'a', hosts: ['a.example'], assign: { project: 'filament', envName: 'TOKEN' } }, HOST)
  store.create({ name: 'B', value: 'b', hosts: ['b.example'] }, HOST)
  expect(() => store.assign('filament', 'B', 'TOKEN', HOST)).toThrow('already has TOKEN (the secret "A")')
  expect(() => store.assign('filament', a.id, 'OTHER', HOST)).toThrow('already assigned to this project as TOKEN')
  expect(() => store.assign('filament', 'Missing', 'X', HOST)).toThrow('There is no secret called "Missing"')
  expect(() => store.assign('filament', 'B', 'PATH', HOST)).toThrow('reserved')
  expect(() => store.assign('filament', 'B', 'lower', HOST)).toThrow('capital letters')
  expect(() => store.create({ name: 'a', value: 'x', hosts: ['a.example'] }, HOST)).toThrow('already exists')
  expect(() =>
    store.create({ name: 'C', value: 'c', hosts: ['c.example'], assign: { project: 'filament', envName: 'TOKEN' } }, HOST),
  ).toThrow('already has TOKEN')
  expect(store.get('C')).toBeUndefined()
})

test('assigning and unassigning change the hosts and the fingerprint', () => {
  const empty = store.fingerprint('filament')
  store.create({ name: 'Spools', value: 'v1', hosts: ['api.spools.example', '*.cdn.example'] }, HOST)
  expect(store.fingerprint('filament')).toBe(empty)
  store.assign('filament', 'Spools', 'SPOOLS', HOST)
  const assigned = store.fingerprint('filament')
  expect(assigned).not.toBe(empty)
  expect(store.hosts('filament')).toEqual(['*.cdn.example', 'api.spools.example'])
  expect(store.unassign('filament', 'SPOOLS', HOST)).toBe(true)
  expect(store.unassign('filament', 'SPOOLS', HOST)).toBe(false)
  expect(store.fingerprint('filament')).toBe(empty)
  expect(store.hosts('filament')).toEqual([])
  expect(store.get('Spools')).toBeDefined()
})

test('updates keep the value or the hosts when left out, and change the fingerprint', () => {
  const secret = store.create({ name: 'Token', value: 'v1', hosts: ['a.example'], assign: { project: 'filament', envName: 'TOKEN' } }, HOST)
  const before = store.fingerprint('filament')
  store.update(secret.id, { hosts: ['b.example'] }, HOST)
  expect(store.forSandbox('filament').TOKEN).toEqual({ value: 'v1', hosts: ['b.example'] })
  const afterHosts = store.fingerprint('filament')
  expect(afterHosts).not.toBe(before)
  store.update('Token', { value: 'v2' }, HOST)
  expect(store.forSandbox('filament').TOKEN?.value).toBe('v2')
  expect(store.remove(secret.id, HOST)).toBe(true)
  expect(store.remove(secret.id, HOST)).toBe(false)
  expect(store.fingerprint('filament')).not.toBe(afterHosts)
  expect(store.fingerprint('alarms')).toBe(store.fingerprint('filament'))
  expect(store.forSandbox('filament')).toEqual({})
})

test('agents can assign, but never create, change or delete secrets', () => {
  const { agent } = createAgentToken(host.db, 'claude')
  const actor: Actor = { kind: 'agent', id: agent.id, name: agent.name }
  const secret = store.create({ name: 'Key', value: 'v', hosts: ['a.example'] }, HOST)
  expect(() => store.create({ name: 'Mine', value: 'x', hosts: ['evil.example'] }, actor)).toThrow('Only people')
  expect(() => store.update(secret.id, { hosts: ['evil.example'] }, actor)).toThrow('Only people')
  expect(() => store.update(secret.id, { value: 'x' }, actor)).toThrow('Only people')
  expect(() => store.remove(secret.id, actor)).toThrow('Only people')
  expect(store.forSandbox('filament')).toEqual({})
  expect(store.assign('filament', 'Key', 'KEY', actor)).toMatchObject({ envName: 'KEY', assignedBy: { kind: 'agent', name: 'claude' } })
  expect(store.get(secret.id)).toMatchObject({ hosts: ['a.example'] })
})

test('assignment changes and changes to assigned secrets show up in the project log', () => {
  const { agent } = createAgentToken(host.db, 'claude')
  const secret = store.create({ name: 'Key', value: 'v', hosts: ['a.example'] }, HOST)
  store.assign('filament', secret.id, 'KEY', { kind: 'agent', id: agent.id, name: agent.name })
  const userId = Number(host.db.prepare("INSERT INTO users (name) VALUES ('Kaan') RETURNING id").get()!.id)
  store.update(secret.id, { hosts: ['b.example'] }, { kind: 'user', id: userId, name: 'Kaan' })
  expect(store.get(secret.id)).toMatchObject({ createdBy: null, updatedBy: 'Kaan' })
  store.unassign('filament', 'KEY', { kind: 'agent', id: agent.id, name: agent.name })
  store.assign('filament', secret.id, 'KEY', HOST)
  store.remove(secret.id, HOST)
  expect(events('filament')).toEqual([
    'Agent claude added the secret "Key" as KEY. It is only sent to a.example',
    'Kaan changed the secret "Key" (KEY): now only sent to b.example',
    'Agent claude removed the secret "Key" (KEY)',
    'Someone on the Hobwork host added the secret "Key" as KEY. It is only sent to b.example',
    'Someone on the Hobwork host deleted the secret "Key", so KEY is gone',
  ])
  expect(events('alarms')).toEqual([])
})

test.each([
  [{ name: '', value: 'x', hosts: ['a.example'] }, 'Give the secret a name'],
  [{ name: 'x'.repeat(81), value: 'x', hosts: ['a.example'] }, 'at most 80'],
  [{ name: 'New', value: 'x', hosts: ['*'] }, 'is not a host name'],
  [{ name: 'New', value: 'x', hosts: ['hobwork.internal'] }, 'is not a host name'],
  [{ name: 'New', value: 'x', hosts: ['https://a.example/path'] }, 'is not a host name'],
  [{ name: 'New', value: '', hosts: ['a.example'] }, 'must not be empty'],
  [{ name: 'New', value: 'two\nlines', hosts: ['a.example'] }, 'single line'],
  [{ name: 'New', value: 'x', hosts: ['a.example'], assign: { project: 'filament', envName: 'HOBWORK_X' } }, 'reserved'],
])('refuses %o', (input, message) => {
  expect(() => store.create(input, HOST)).toThrow(message)
  expect(store.list()).toEqual([])
})

// Encrypts like the store did before migration 0010.
function encryptV1(projectId: number | null, name: string, value: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(`hobwork-secret:v1:${projectId ?? 'global'}:${name}`))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}

test('migration 0010 turns project and global secrets into assigned library secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobwork-migrations-'))
  try {
    for (const file of readdirSync(migrationsDir)) {
      if (Number(file.slice(0, 4)) <= 9) cpSync(join(migrationsDir, file), join(dir, file))
    }
    const db = openDb(':memory:')
    migrate(db, dir)
    const project = (name: string) => Number(db.prepare('INSERT INTO projects (name) VALUES (?) RETURNING id').get(name)!.id)
    const filament = project('filament')
    const alarms = project('alarms')
    const lights = project('lights')
    const insert = db.prepare('INSERT INTO secrets (project_id, name, value, hosts) VALUES (?, ?, ?, ?)')
    const add = (projectId: number | null, name: string, value: string, hosts: string[]) =>
      insert.run(projectId, name, encryptV1(projectId, name, value), JSON.stringify(hosts))
    add(null, 'SHARED', 'global-shared', ['shared.example'])
    add(null, 'ONLY_GLOBAL', 'global-only', ['g.example'])
    add(filament, 'SHARED', 'filament-shared', ['own.example'])
    add(filament, 'SPOOL_KEY', 'spool', ['spools.example'])
    add(alarms, 'SAME', 'alarms-same', ['same.example'])
    add(lights, 'SAME', 'lights-same', ['same.example'])

    migrate(db, migrationsDir)
    const migrated = createSecretStore({ db, dataDir: dir }, key)

    expect(migrated.list().map((s) => [s.name, s.assignments.map((a) => `${a.project}:${a.envName}`)])).toEqual([
      ['ONLY_GLOBAL', ['alarms:ONLY_GLOBAL', 'filament:ONLY_GLOBAL', 'lights:ONLY_GLOBAL']],
      ['SAME (alarms)', ['alarms:SAME']],
      ['SAME (lights)', ['lights:SAME']],
      ['SHARED', ['alarms:SHARED', 'lights:SHARED']],
      ['SHARED (filament)', ['filament:SHARED']],
      ['SPOOL_KEY', ['filament:SPOOL_KEY']],
    ])
    expect(migrated.forSandbox('filament')).toEqual({
      ONLY_GLOBAL: { value: 'global-only', hosts: ['g.example'] },
      SHARED: { value: 'filament-shared', hosts: ['own.example'] },
      SPOOL_KEY: { value: 'spool', hosts: ['spools.example'] },
    })
    expect(migrated.forSandbox('alarms')).toEqual({
      ONLY_GLOBAL: { value: 'global-only', hosts: ['g.example'] },
      SAME: { value: 'alarms-same', hosts: ['same.example'] },
      SHARED: { value: 'global-shared', hosts: ['shared.example'] },
    })
    expect(migrated.forSandbox('lights').SAME?.value).toBe('lights-same')
    expect(migrated.assigned('alarms')[0]?.assignedBy).toBeNull()

    // Values were re-encrypted for their new rows, so the old additional data is gone.
    expect(db.prepare('SELECT count(*) AS n FROM secrets WHERE legacy_aad IS NOT NULL').get()).toEqual({ n: 0 })
    expect(createSecretStore({ db, dataDir: dir }, key).forSandbox('lights').SAME?.value).toBe('lights-same')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrated values that do not decrypt with the key stay as they were', () => {
  host.db
    .prepare(`INSERT INTO secrets (name, value, hosts, legacy_aad) VALUES ('OLD', ?, '["a.example"]', 'hobwork-secret:v1:global:OLD')`)
    .run(encryptV1(null, 'OLD', 'old-value'))
  const filament = Number(host.db.prepare(`SELECT id FROM projects WHERE name = 'filament'`).get()!.id)
  host.db.prepare(`INSERT INTO secret_assignments (project_id, secret_id, env_name) SELECT ?, id, 'OLD' FROM secrets`).run(filament)
  expect(() => createSecretStore(host, randomBytes(32)).forSandbox('filament')).toThrow('cannot be decrypted')
  expect(createSecretStore(host, key).forSandbox('filament').OLD?.value).toBe('old-value')
})
