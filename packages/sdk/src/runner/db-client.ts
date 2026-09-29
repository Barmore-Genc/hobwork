import type { Db, Row, SqlParams, SqlValue, Statement, StatementResult } from '../index.ts'
import type { DbRequest, DbResponse, WireResult, WireStatement, WireValue } from './protocol.ts'

export class DbError extends Error {
  code?: string
  // Index of the failing statement in a batch.
  statement?: number

  constructor(message: string, code?: string, statement?: number) {
    super(message)
    this.name = 'DbError'
    this.code = code
    this.statement = statement
  }
}

export function encodeValue(value: SqlValue): WireValue {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  throw new TypeError(`Cannot store a value of type ${value === undefined ? 'undefined' : typeof value} in SQLite`)
}

export function decodeValue(value: WireValue): null | number | string | bigint | Uint8Array {
  if (value !== null && typeof value === 'object') {
    if ('$blob' in value) return new Uint8Array(Buffer.from(value.$blob, 'base64'))
    return BigInt(value.$bigint)
  }
  return value
}

function encodeStatement({ sql, params }: Statement): WireStatement {
  if (typeof sql !== 'string') throw new TypeError('SQL must be a string')
  if (params === undefined) return { sql }
  if (Array.isArray(params)) return { sql, params: params.map(encodeValue) }
  return { sql, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, encodeValue(v)])) }
}

function decodeResult(result: WireResult): StatementResult {
  return {
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid,
    rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, decodeValue(v)])) as Row),
  }
}

// `send` delivers a request to whatever executes it: the host in a VM, or a
// local SQLite database in tests.
export function createDbClient(send: (request: DbRequest) => Promise<DbResponse>): Db {
  async function execute(statements: Statement[], transaction: boolean): Promise<StatementResult[]> {
    const response = await send({ statements: statements.map(encodeStatement), transaction })
    if (!response.ok) throw new DbError(response.error.message, response.error.code, response.error.statement)
    return response.results.map(decodeResult)
  }

  return {
    async query<T = Row>(sql: string, params?: SqlParams) {
      const [result] = await execute([{ sql, params }], false)
      return (result?.rows ?? []) as T[]
    },
    async get<T = Row>(sql: string, params?: SqlParams) {
      const [result] = await execute([{ sql, params }], false)
      return result?.rows[0] as T | undefined
    },
    async run(sql: string, params?: SqlParams) {
      const [result] = await execute([{ sql, params }], false)
      return { changes: result?.changes ?? 0, lastInsertRowid: result?.lastInsertRowid ?? 0 }
    },
    batch(statements: Statement[]) {
      return statements.length ? execute(statements, true) : Promise.resolve([])
    },
  }
}

export function httpDbSender(baseUrl: string, invocation?: () => number | undefined) {
  return async (request: DbRequest): Promise<DbResponse> => {
    const res = await fetch(new URL('/v1/db', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, invocation: invocation?.() }),
    })
    const body = (await res.json().catch(() => undefined)) as DbResponse | { error?: string } | undefined
    if (body && 'ok' in body) return body
    throw new DbError(`The host could not run the query: HTTP ${res.status}${body?.error ? ` ${body.error}` : ''}`)
  }
}
