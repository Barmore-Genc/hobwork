// Test helpers for hob code: `import { createTestDb, createTestContext } from '@hobwork/sdk/testing'`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createExecutor } from './db/execute.ts'
import { applyMigrations, MIGRATIONS_DIR, notStrictMessage, parseMigrations } from './db/migrations.ts'
import type { Device } from './devices.ts'
import type { HomeAssistant } from './homeassistant.ts'
import type { Context, Db, Logger } from './index.ts'
import { createDbClient } from './runner/db-client.ts'

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

export type TestContextOverrides = Omit<Partial<Context>, 'ha' | 'device'> & {
  // Methods not given reject, like fetch.
  ha?: Partial<HomeAssistant>
  device?: (name: string) => DeviceStub
}

// A handler context for tests. `db` defaults to a fresh test DB; `fetch`, `ha`
// and devices reject until a test stubs them, since tests should not reach the
// network, change the home or notify anyone.
export function createTestContext(overrides: TestContextOverrides = {}): Context {
  return {
    invocation: { id: 1, kind: 'route', name: 'test', manual: true },
    params: {},
    fetch: () => Promise.reject(new Error('ctx.fetch is not stubbed in this test. Pass fetch to createTestContext')),
    log: silent,
    secrets: {},
    devices: () => Promise.reject(new Error('ctx.devices is not stubbed in this test. Pass devices to createTestContext')),
    ...overrides,
    ha: { ...unstubbedHa(), ...overrides.ha },
    device: (name) => stubbedDevice(name, overrides.device?.(name)),
    db: overrides.db ?? createTestDb(),
  }
}
