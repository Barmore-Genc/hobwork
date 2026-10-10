import type { Device, DeviceInfo } from './devices.ts'
import type { HomeAssistant } from './homeassistant.ts'
import type { Caller, Person, PersonDevices } from './people.ts'
import type { FileInfo } from './runner/protocol.ts'

export type * from './devices.ts'
export type * from './homeassistant.ts'
export type * from './people.ts'
export * from './time.ts'
export { DeviceError } from './runner/device-client.ts'
export { FilesError } from './runner/files-client.ts'
export type { FileInfo, FilesErrorCode } from './runner/protocol.ts'
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
  // Who made the request, for routes called from the hob's UI by a signed-in
  // person. null for crons, webhooks, triggers, manual invocations, share
  // links and agents.
  caller: Caller | null
  // The event for triggers (Home Assistant trigger variables, a DeviceEvent
  // such as NotificationActionEvent), or what a manual invocation passed.
  payload?: unknown
  // Outgoing HTTP. Only hosts listed in `egress` in hobwork.json are reachable.
  fetch: typeof fetch
  // Log lines are stored with the invocation. console.log and friends work too.
  log: Logger
  // The hob DB. See `Db`.
  db: Db
  // The hob's files, which hobwork.json can serve under `static`. See `Files`.
  files: Files
  // Home Assistant service calls and states, through the Hobwork host.
  ha: HomeAssistant
  // A paired phone or computer by name, e.g. ctx.device('kaan-iphone').notifications.send(...).
  // Calls go through the Hobwork host.
  device(name: string): Device
  // Paired devices with their capabilities and whether they are connected.
  devices(): Promise<DeviceInfo[]>
  // Everyone who can sign in to Hobwork.
  people(): Promise<Person[]>
  // A person's devices by Person.id, e.g. ctx.person(ctx.caller.person.id).lastActiveDevice().
  person(id: number): PersonDevices
  // Secret name -> placeholder. Send the placeholder over https in the
  // Authorization header (or a header the secret lists) to a host the secret is
  // bound to, and Hobwork replaces it with the real value on the way out. It is
  // not replaced in URLs or bodies. The real value never reaches handler code.
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

// What `Files.put` stores. Strings are stored as UTF-8.
export type FileBody = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>

export type StoredFile = FileInfo & {
  // Read one of these once.
  body: ReadableStream<Uint8Array>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
}

export type ListFilesOptions = {
  // Only paths that start with this, e.g. "photos/".
  prefix?: string
  // Only paths after this one, for the next page: the last path of the previous page.
  after?: string
  // At most this many, 1000 at most (the default).
  limit?: number
}

// Files of the hob, stored by the host. Paths are like "photos/2026/cat.jpg":
// segments of letters, digits, ".", "_" and "-", none starting with ".". The
// deployed version and every branch preview share the same files. Errors throw
// `FilesError`.
export interface Files {
  // Creates or replaces the file, up to 1 GB. A path cannot be both a file and
  // a directory: storing "a/b" fails while "a" is a file, and the other way round.
  put(path: string, body: FileBody): Promise<FileInfo>
  // The file, or undefined when there is none.
  get(path: string): Promise<StoredFile | undefined>
  // The file's size and modification time, or undefined when there is none.
  stat(path: string): Promise<FileInfo | undefined>
  // True when there was a file to delete. Empty directories go with it.
  delete(path: string): Promise<boolean>
  // Files in path order.
  list(options?: ListFilesOptions): Promise<FileInfo[]>
}
