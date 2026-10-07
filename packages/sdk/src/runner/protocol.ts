// Messages between the host and the runner in a project runtime VM. The host
// reaches the runner over the VM's ingress, and the runner reaches the host at
// http://hobwork.internal. Both sides ship together with the host, so there is
// no versioning.
import type { HaServiceTarget, HaStatesFilter } from '../homeassistant.ts'
import type { Invocation, LogLevel } from '../index.ts'

// Here rather than in homeassistant.ts, since runtime VMs get the runner
// directory without the rest of the SDK and only type imports may leave it.
export const HA_MAX_RETRIES = 5

// Inside the guest. Nothing else listens there.
export const RUNNER_PORT = 8080

// The guest file the host writes the runner's token to before starting it. The
// runner reads and deletes it, so it is gone before any handler code runs.
export const RUNNER_TOKEN_FILE = '/tmp/hobwork-runner-token'

// Largest response body a handler may return. Bodies travel as base64 in the
// invoke result, so the host allows for that and for the rest of the JSON.
export const MAX_RESPONSE_BODY_BYTES = 24 * 1024 * 1024
export const MAX_INVOKE_RESULT_BYTES = Math.ceil((MAX_RESPONSE_BODY_BYTES * 4) / 3) + 1024 * 1024

export type SerializedRequest = {
  method: string
  url: string
  headers: [string, string][]
  // Base64.
  body?: string
}

export type SerializedResponse = {
  status: number
  headers: [string, string][]
  // Base64.
  body: string
}

// POST /invoke
export type InvokeRequest = {
  invocation: Invocation
  // Handler path from hobwork.json, e.g. "src/spools.ts".
  handler: string
  request?: SerializedRequest
  params?: Record<string, string>
  payload?: unknown
}

export type SerializedError = { name: string; message: string; stack?: string }

export type InvokeResult =
  | { ok: true; response: SerializedResponse }
  | { ok: false; error: SerializedError }

export type LogLine = {
  invocation?: number
  level: LogLevel
  message: string
  time: string
}

// POST http://hobwork.internal/v1/logs
export type LogBatch = { lines: LogLine[] }

// Blobs and bigints do not survive JSON as they are.
export type WireValue = null | number | string | { $blob: string } | { $bigint: string }

export type WireStatement = { sql: string; params?: WireValue[] | Record<string, WireValue> }

// POST http://hobwork.internal/v1/db
export type DbRequest = {
  statements: WireStatement[]
  // Runs the statements in one transaction (Db.batch).
  transaction: boolean
  // Set by the runner inside an invocation, so slow queries are logged with it.
  invocation?: number
}

export type WireResult = {
  rows: Record<string, WireValue>[]
  changes: number
  lastInsertRowid: number
}

// `statement` is the index of the statement that failed.
export type DbResponse =
  | { ok: true; results: WireResult[] }
  | { ok: false; error: { message: string; code?: string; statement?: number } }

// POST http://hobwork.internal/v1/ha
export type HaRequest = (
  | {
      action: 'callService'
      domain: string
      service: string
      data?: Record<string, unknown>
      target?: HaServiceTarget
      returnResponse?: boolean
    }
  | { action: 'getState'; entityId: string }
  | { action: 'getStates'; filter?: HaStatesFilter }
  | { action: 'fireEvent'; eventType: string; data?: Record<string, unknown> }
) & {
  // Set by the runner inside an invocation, so the call is logged with it.
  invocation?: number
  timeoutMs?: number
}

export type HaResponse = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }

// POST http://hobwork.internal/v1/devices
export type DeviceRequest = (
  | { action: 'list' }
  | { action: 'call'; device: string; capability: string; method: string; args?: unknown }
) & {
  // Set by the runner inside an invocation, so the call is logged with it.
  invocation?: number
}

export type DeviceResponse = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }

// PUT http://hobwork.internal/v1/files/<path> stores the body (streamed, up to
// MAX_FILE_BYTES) and answers FilesResponse with a FileInfo. GET on the same
// path answers the bytes with FILE_SIZE_HEADER and FILE_MODIFIED_HEADER (the
// body is streamed, so Content-Length may be gone), or a FilesResponse error.
// Each path segment is URI-encoded.
export const FILES_PATH = '/v1/files'
export const MAX_FILE_BYTES = 1024 * 1024 * 1024
export const FILE_SIZE_HEADER = 'x-hobwork-size'
export const FILE_MODIFIED_HEADER = 'x-hobwork-modified'
export const MAX_FILE_LIST = 1000

export type FileInfo = { path: string; size: number; modified: string }

// POST http://hobwork.internal/v1/files
export type FilesRequest =
  | { action: 'stat'; path: string }
  | { action: 'delete'; path: string }
  | { action: 'list'; prefix?: string; after?: string; limit?: number }

export type FilesErrorCode = 'invalid_path' | 'not_found' | 'too_large' | 'conflict' | 'unavailable'

export type FilesResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: FilesErrorCode; message: string } }

const MAX_FILE_PATH_LENGTH = 512
const MAX_FILE_PATH_DEPTH = 16
// No leading dot, so nothing can be named `.` or `..` and dotfiles cannot be
// stored, and only characters that need no escaping on any file system.
const FILE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/

// What is wrong with a file path like "photos/2026/cat.jpg", or undefined.
// The host checks this too.
export function filePathProblem(path: unknown): string | undefined {
  if (typeof path !== 'string' || path === '') return 'A file path must be a non-empty string'
  if (path.length > MAX_FILE_PATH_LENGTH) return `A file path is at most ${MAX_FILE_PATH_LENGTH} characters`
  const segments = path.split('/')
  if (segments.length > MAX_FILE_PATH_DEPTH) return `A file path has at most ${MAX_FILE_PATH_DEPTH} segments`
  if (!segments.every((segment) => FILE_SEGMENT.test(segment))) {
    return `"${path}" is not a valid file path: use segments of letters, digits, ".", "_" and "-" separated by "/", none starting with "."`
  }
  return undefined
}

// The URL path of a file under FILES_PATH. Expects a valid path.
export function fileUrlPath(path: string): string {
  return `${FILES_PATH}/${path.split('/').map(encodeURIComponent).join('/')}`
}

// Where `pnpm build` puts a handler, relative to the build's root (the
// project's dist/). The template's vite.config.ts writes the same layout.
export function handlerModulePath(handler: string): string {
  return `handlers/${handler.replace(/^\.\//, '').replace(/\.[cm]?[jt]sx?$/, '')}.js`
}
