// Test helpers for project code: `import { createTestDb, createTestContext } from '@hobwork/sdk/testing'`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createExecutor } from './db/execute.ts'
import { applyMigrations, MIGRATIONS_DIR, notStrictMessage, parseMigrations } from './db/migrations.ts'
import type { HomeAssistant } from './homeassistant.ts'
import type { Context, Db, Logger } from './index.ts'
import { createDbClient } from './runner/db-client.ts'

export type TestDbOptions = {
  // Directory with the migrations. Default: migrations/ in the current directory
  // (the project root when running `pnpm test`).
  migrations?: string
}

// A fresh in-memory project DB with every migration applied. It follows the
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

export type TestContextOverrides = Omit<Partial<Context>, 'ha'> & {
  // Methods not given reject, like fetch.
  ha?: Partial<HomeAssistant>
}

// A handler context for tests. `db` defaults to a fresh test DB; `fetch` and
// `ha` reject until a test stubs them, since tests should not reach the network
// or change the home.
export function createTestContext(overrides: TestContextOverrides = {}): Context {
  return {
    invocation: { id: 1, kind: 'route', name: 'test', manual: true },
    params: {},
    fetch: () => Promise.reject(new Error('ctx.fetch is not stubbed in this test. Pass fetch to createTestContext')),
    log: silent,
    secrets: {},
    ...overrides,
    ha: { ...unstubbedHa(), ...overrides.ha },
    db: overrides.db ?? createTestDb(),
  }
}
