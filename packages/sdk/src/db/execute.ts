// Runs handler queries against a hob DB. The host runs it for hob VMs,
// and `@hobwork/sdk/testing` runs it against in-memory DBs, so tests hit the
// same rules as deployed code.
import { constants, type DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import type { DbRequest, DbResponse, WireResult, WireStatement, WireValue } from '../runner/protocol.ts'
import { MIGRATIONS_TABLE } from './migrations.ts'
import { firstKeyword, splitStatements } from './sql.ts'

export const MAX_ROWS = 10_000
export const MAX_STATEMENTS = 1_000

// Read-only schema introspection. Every other PRAGMA changes connection or
// database state that belongs to the host.
const ALLOWED_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'integrity_check',
  'quick_check',
  'collation_list',
  'function_list',
  'pragma_list',
  'page_count',
  'page_size',
  'freelist_count',
])

const SCHEMA_CHANGES = new Set([
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_DROP_VTABLE,
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_ANALYZE,
])

const WRITES = new Set([constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE])

const SCHEMA_MESSAGE = 'Statements cannot change the schema. Add a migration in migrations/ instead'
const TRANSACTION_MESSAGE =
  'Transactions cannot span several calls. Use ctx.db.batch([...]) to run statements in one transaction'

export class QueryError extends Error {
  code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

export type StatementTiming = { sql: string; durationMs: number }

export type Execution = { response: DbResponse; timings: StatementTiming[] }

function decodeParam(value: WireValue): SQLInputValue {
  if (value !== null && typeof value === 'object') {
    if ('$blob' in value && typeof value.$blob === 'string') return new Uint8Array(Buffer.from(value.$blob, 'base64'))
    if ('$bigint' in value && typeof value.$bigint === 'string') return BigInt(value.$bigint)
    throw new QueryError('Parameters must be null, numbers, strings, booleans, bigints or Uint8Arrays')
  }
  if (value !== null && typeof value !== 'number' && typeof value !== 'string') {
    throw new QueryError('Parameters must be null, numbers, strings, booleans, bigints or Uint8Arrays')
  }
  return value
}

function encodeColumn(value: unknown): WireValue {
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString('base64') }
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  return value as WireValue
}

function sqliteErrorCode(err: unknown): string | undefined {
  const errstr = (err as { errstr?: unknown }).errstr
  return typeof errstr === 'string' ? errstr : undefined
}

// Installs the authorizer that keeps handler statements to reading and writing
// rows. The host's own statements (BEGIN, COMMIT) run through `asHost`.
export function createExecutor(db: DatabaseSync) {
  let host = false
  let denied: string | undefined
  let writes = false

  db.setAuthorizer((action, arg1, arg2) => {
    if (host) return constants.SQLITE_OK
    const deny = (reason: string) => {
      denied ??= reason
      return constants.SQLITE_DENY
    }
    if (SCHEMA_CHANGES.has(action)) return deny(SCHEMA_MESSAGE)
    if (action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT) return deny(TRANSACTION_MESSAGE)
    if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) {
      return deny('Statements can only use the hob DB (ATTACH and DETACH are not allowed)')
    }
    if (action === constants.SQLITE_PRAGMA && !ALLOWED_PRAGMAS.has(String(arg1).toLowerCase())) {
      return deny(`PRAGMA ${arg1} is not allowed. Only schema introspection PRAGMAs such as table_info work`)
    }
    if (action === constants.SQLITE_FUNCTION && String(arg2).toLowerCase() === 'load_extension') {
      return deny('Extensions cannot be loaded')
    }
    if (WRITES.has(action)) {
      if (arg1 === MIGRATIONS_TABLE) return deny(`${MIGRATIONS_TABLE} belongs to Hobwork and is read-only`)
      writes = true
    }
    return constants.SQLITE_OK
  })

  function asHost<T>(fn: () => T): T {
    host = true
    try {
      return fn()
    } finally {
      host = false
    }
  }

  function prepare(sql: string): { stmt: StatementSync; writes: boolean } {
    if (typeof sql !== 'string') throw new QueryError('SQL must be a string')
    const keyword = firstKeyword(sql)
    if (keyword === 'VACUUM') throw new QueryError('VACUUM is not allowed. Hobwork maintains the hob DB')
    if (['CREATE', 'DROP', 'ALTER'].includes(keyword)) throw new QueryError(SCHEMA_MESSAGE)
    if (['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(keyword)) {
      throw new QueryError(TRANSACTION_MESSAGE)
    }
    const count = splitStatements(sql).length
    if (count === 0) throw new QueryError('SQL is empty')
    if (count > 1) throw new QueryError('Each SQL string must hold one statement. Use ctx.db.batch([...]) for several')
    denied = undefined
    writes = false
    try {
      const stmt = db.prepare(sql)
      return { stmt, writes }
    } catch (err) {
      if (denied) throw new QueryError(denied, 'not authorized')
      throw new QueryError((err as Error).message, sqliteErrorCode(err))
    }
  }

  function run(statement: WireStatement): WireResult {
    const { stmt, writes: isWrite } = prepare(statement.sql)
    const raw = statement.params
    let args: SQLInputValue[] = []
    let named: Record<string, SQLInputValue> | undefined
    if (Array.isArray(raw)) args = raw.map(decodeParam)
    else if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'object') throw new QueryError('Parameters must be an array or an object')
      named = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decodeParam(v)]))
    }
    // node:sqlite takes named parameters as a leading object.
    const params = (named ? [named] : args) as SQLInputValue[]
    try {
      if (stmt.columns().length === 0) {
        const result = stmt.run(...params)
        return { rows: [], changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
      }
      const rows: WireResult['rows'] = []
      for (const row of stmt.iterate(...params)) {
        if (rows.length === MAX_ROWS) {
          throw new QueryError(`The query returned more than ${MAX_ROWS} rows. Add a LIMIT and page through the results`)
        }
        rows.push(Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, encodeColumn(v)])))
      }
      if (!isWrite) return { rows, changes: 0, lastInsertRowid: 0 }
      const info = asHost(() => db.prepare('SELECT changes() AS c, last_insert_rowid() AS r').get()) as { c: number; r: number }
      return { rows, changes: Number(info.c), lastInsertRowid: Number(info.r) }
    } catch (err) {
      if (err instanceof QueryError) throw err
      // Table-valued PRAGMA functions are authorized when they run, not when prepared.
      if (denied) throw new QueryError(denied, 'not authorized')
      throw new QueryError((err as Error).message, sqliteErrorCode(err))
    }
  }

  function execute(request: DbRequest): Execution {
    const timings: StatementTiming[] = []
    const statements = request?.statements
    if (!Array.isArray(statements)) {
      return { response: { ok: false, error: { message: 'statements must be an array' } }, timings }
    }
    if (statements.length > MAX_STATEMENTS) {
      return { response: { ok: false, error: { message: `A batch holds at most ${MAX_STATEMENTS} statements` } }, timings }
    }
    const results: WireResult[] = []
    let index = 0
    const transaction = request.transaction === true
    try {
      if (transaction) asHost(() => db.exec('BEGIN IMMEDIATE'))
      for (; index < statements.length; index++) {
        const statement = statements[index]!
        const started = performance.now()
        try {
          results.push(run(statement))
        } finally {
          timings.push({ sql: String(statement?.sql), durationMs: performance.now() - started })
        }
      }
      if (transaction) asHost(() => db.exec('COMMIT'))
      return { response: { ok: true, results }, timings }
    } catch (err) {
      if (transaction && db.isTransaction) asHost(() => db.exec('ROLLBACK'))
      const error = err instanceof QueryError ? err : new QueryError((err as Error).message, sqliteErrorCode(err))
      return {
        response: {
          ok: false,
          error: {
            message: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...(index < statements.length ? { statement: index } : {}),
          },
        },
        timings,
      }
    }
  }

  // Runs host code (like copying the DB) on the connection, past the authorizer.
  return { execute, asHost }
}

export type Executor = ReturnType<typeof createExecutor>
