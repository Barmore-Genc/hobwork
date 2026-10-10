// Test helpers for hob code: `import { createTestDb, createTestFiles, createTestContext } from '@hobwork/sdk/testing'`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createExecutor } from './db/execute.ts'
import { applyMigrations, MIGRATIONS_DIR, notStrictMessage, parseMigrations } from './db/migrations.ts'
import type { Device, DeviceInfo } from './devices.ts'
import type { HomeAssistant } from './homeassistant.ts'
import type { Context, Db, FileBody, FileInfo, Files, Logger, StoredFile } from './index.ts'
import { createDbClient } from './runner/db-client.ts'
import { checkFilePath, FilesError } from './runner/files-client.ts'
import { MAX_FILE_BYTES, MAX_FILE_LIST } from './runner/protocol.ts'

export type TestDbOptions = {
  // Directory with the migrations. Default: migrations/ in the current directory
  // (the hob root when running `pnpm test`).
  migrations?: string
}

// A fresh in-memory hob DB with every migration applied. It follows the
// same rules as the deployed DB (one statement per call, no schema changes, no
// interactive transactions), so tests catch what would fail after deploy.
export function createTestDb(options: TestDbOptions = {}): Db {
  const dir = resolve(options.migrations ?? MIGRATIONS_DIR)
  const files = existsSync(dir)
    ? readdirSync(dir).map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
    : []
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const outcome = applyMigrations(db, parseMigrations(files))
  if (outcome.notStrict.length) throw new Error(notStrictMessage(outcome.notStrict))
  const { execute } = createExecutor(db)
  // The JSON round trip matches what crosses the wire in a VM.
  return createDbClient(async (request) => JSON.parse(JSON.stringify(execute(JSON.parse(JSON.stringify(request))).response)))
}

async function bytesOf(body: FileBody): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body.slice()
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))
  return new Uint8Array(await new Response(body).arrayBuffer())
}

// Empty in-memory files for ctx.files, with the same path rules and errors as
// the host.
export function createTestFiles(): Files {
  const files = new Map<string, { bytes: Uint8Array; modified: string }>()
  const info = (path: string): FileInfo | undefined => {
    const file = files.get(path)
    return file && { path, size: file.bytes.length, modified: file.modified }
  }
  return {
    async put(path, body) {
      checkFilePath(path)
      const bytes = await bytesOf(body)
      if (bytes.length > MAX_FILE_BYTES) throw new FilesError('too_large', `A file is at most ${MAX_FILE_BYTES} bytes`)
      const parents = path.split('/').slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join('/'))
      const parent = parents.find((p) => files.has(p))
      if (parent) throw new FilesError('conflict', `"${parent}" is a file, so "${path}" cannot be stored`)
      if ([...files.keys()].some((p) => p.startsWith(`${path}/`))) {
        throw new FilesError('conflict', `"${path}" is a directory`)
      }
      files.set(path, { bytes, modified: new Date().toISOString() })
      return info(path)!
    },
    async get(path) {
      checkFilePath(path)
      const found = info(path)
      if (!found) return undefined
      const bytes = files.get(path)!.bytes.slice()
      const file: StoredFile = {
        ...found,
        body: new Blob([bytes]).stream(),
        bytes: async () => bytes,
        text: async () => new TextDecoder().decode(bytes),
      }
      return file
    },
    async stat(path) {
      checkFilePath(path)
      return info(path)
    },
    async delete(path) {
      checkFilePath(path)
      return files.delete(path)
    },
    async list({ prefix = '', after = '', limit = MAX_FILE_LIST } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FILE_LIST) {
        throw new FilesError('invalid_path', `limit must be a whole number from 1 to ${MAX_FILE_LIST}`)
      }
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix) && path > after)
        .sort()
        .slice(0, limit)
        .map((path) => info(path)!)
    },
  }
}

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function unstubbedHa(): HomeAssistant {
  const reject = (method: string) => () =>
    Promise.reject(new Error(`ctx.ha.${method} is not stubbed in this test. Pass ha: { ${method} } to createTestContext`))
  return { callService: reject('callService'), getState: reject('getState'), getStates: reject('getStates'), fireEvent: reject('fireEvent') }
}

const DEVICE_METHODS: { [C in keyof Device]: (keyof Device[C])[] } = {
  notifications: ['send'],
  alarms: ['set', 'timer', 'cancel', 'list'],
  screenTime: ['sets', 'block', 'unblock', 'schedule', 'removeSchedule', 'limit', 'removeLimit', 'status'],
  focus: ['status'],
  nfc: ['write', 'read'],
  health: ['query'],
}

// What a test fake of ctx.device may return: any capabilities and methods.
export type DeviceStub = { [C in keyof Device]?: Partial<Device[C]> }

// Methods the stub leaves out reject, like fetch.
function stubbedDevice(name: string, stub: DeviceStub = {}): Device {
  const device: Record<string, Record<string, unknown>> = {}
  for (const [capability, methods] of Object.entries(DEVICE_METHODS) as [keyof Device, string[]][]) {
    const given = (stub[capability] ?? {}) as Record<string, unknown>
    device[capability] = Object.fromEntries(
      methods.map((method) => [
        method,
        given[method] ??
          (() =>
            Promise.reject(
              new Error(
                `ctx.device('${name}').${capability}.${method} is not stubbed in this test. Pass device: (name) => ({ ${capability}: { ${method} } }) to createTestContext`,
              ),
            )),
      ]),
    )
  }
  return device as unknown as Device
}

// Most recently used first, as the host orders a person's devices.
function byLastActive(a: DeviceInfo, b: DeviceInfo): number {
  return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '') || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '')
}

export type TestContextOverrides = Omit<Partial<Context>, 'ha' | 'device'> & {
  // Methods not given reject, like fetch.
  ha?: Partial<HomeAssistant>
  device?: (name: string) => DeviceStub
}

// A handler context for tests. `db` defaults to a fresh test DB and `files` to
// empty test files; `fetch`, `ha` and devices reject until a test stubs them,
// since tests should not reach the network, change the home or notify anyone.
// `caller` defaults to null. ctx.person(id) reads the stubbed ctx.devices(),
// so stub devices with ownerId and lastActiveAt to test who gets notified.
export function createTestContext(overrides: TestContextOverrides = {}): Context {
  const devices =
    overrides.devices ?? (() => Promise.reject(new Error('ctx.devices is not stubbed in this test. Pass devices to createTestContext')))
  const personDevices = async (id: number) => (await devices()).filter((d) => d.ownerId === id).sort(byLastActive)
  return {
    invocation: { id: 1, kind: 'route', name: 'test', manual: true },
    params: {},
    caller: null,
    fetch: () => Promise.reject(new Error('ctx.fetch is not stubbed in this test. Pass fetch to createTestContext')),
    log: silent,
    secrets: {},
    people: () => Promise.reject(new Error('ctx.people is not stubbed in this test. Pass people to createTestContext')),
    person: (id) => ({
      devices: () => personDevices(id),
      lastActiveDevice: async () => (await personDevices(id))[0],
    }),
    ...overrides,
    devices,
    ha: { ...unstubbedHa(), ...overrides.ha },
    device: (name) => stubbedDevice(name, overrides.device?.(name)),
    db: overrides.db ?? createTestDb(),
    files: overrides.files ?? createTestFiles(),
  }
}
