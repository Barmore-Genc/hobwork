import type { Device, DeviceInfo } from './devices.ts'
import type { HomeAssistant } from './homeassistant.ts'

export type * from './devices.ts'
export type * from './homeassistant.ts'
export { DeviceError } from './runner/device-client.ts'
export { HomeAssistantError } from './runner/ha-client.ts'
export * from './openrouter.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = Record<LogLevel, (...args: unknown[]) => void>

export type InvocationKind = 'route' | 'webhook' | 'cron' | 'trigger'

export type Invocation = {
  id: number
  kind: InvocationKind
  // The route key from hobwork.json ("GET /spools/:id"), or the cron, webhook or trigger name.
  name: string
  // True when started with the invoke tool rather than by a request, schedule or event.
  manual: boolean
}

export type Context = {
  invocation: Invocation
  // The HTTP request, for routes and webhooks.
  request?: Request
  // Values of `:name` segments in the route path.
  params: Record<string, string>
  // The event for triggers (Home Assistant trigger variables, a device event
  // such as NotificationActionEvent), or what a manual invocation passed.
  payload?: unknown
  // Outgoing HTTP. Only hosts listed in `egress` in hobwork.json are reachable.
  fetch: typeof fetch
  // Log lines are stored with the invocation. console.log and friends work too.
  log: Logger
  // The project DB. See `Db`.
  db: Db
  // Home Assistant service calls and states, through the Hobwork host.
  ha: HomeAssistant
  // A paired phone or computer by name, e.g. ctx.device('kaan-iphone').notifications.send(...).
  // Calls go through the Hobwork host.
  device(name: string): Device
  // Paired devices with their capabilities and whether they are connected.
  devices(): Promise<DeviceInfo[]>
  // Secret name -> placeholder. Send the placeholder in a request header to a
  // host the secret is bound to, and Hobwork replaces it with the real value on
  // the way out. The real value never reaches handler code.
  secrets: Record<string, string>
}

export type RequestContext = Context & { request: Request }

// A route or webhook handler may return a Response, which is sent as is, or any
// other value, which is sent as JSON (undefined sends 204 No Content).
export type Handler<C extends Context = Context> = (ctx: C) => unknown

export type RequestHandler = Handler<RequestContext>

// Values SQLite stores. Booleans are stored as 1 and 0. Integers come back as
// numbers, so integers beyond Number.MAX_SAFE_INTEGER are not supported.
export type SqlValue = null | number | bigint | string | boolean | Uint8Array

// `?` placeholders take an array, `:name`, `@name` and `$name` placeholders an
// object keyed by the name without its prefix.
export type SqlParams = SqlValue[] | Record<string, SqlValue>

export type Row = Record<string, null | number | string | Uint8Array>

export type Statement = { sql: string; params?: SqlParams }

export type RunResult = {
  // Rows inserted, updated or deleted.
  changes: number
  lastInsertRowid: number
}

export type StatementResult = RunResult & { rows: Row[] }

// Every call is one request to the host, so there are no interactive
// transactions: `batch` runs its statements in one transaction and rolls all of
// them back if one fails. Each SQL string holds one statement. The schema comes
// from migrations/*.sql, so statements cannot create, change or drop tables.
export interface Db {
  query<T = Row>(sql: string, params?: SqlParams): Promise<T[]>
  // First row, or undefined.
  get<T = Row>(sql: string, params?: SqlParams): Promise<T | undefined>
  run(sql: string, params?: SqlParams): Promise<RunResult>
  batch(statements: Statement[]): Promise<StatementResult[]>
}
