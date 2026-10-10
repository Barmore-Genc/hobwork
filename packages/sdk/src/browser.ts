// Client for hob UIs calling their own routes with the signed-in user's
// session. Hobwork serves each hob UI at the root of its own origin, and
// the hob's routes under /api/ on that origin.

import { UPLOADS_PATH, type UploadedFile, type UploadStatus } from './uploads.ts'

export type { UploadedFile } from './uploads.ts'

// Hobwork refuses state-changing requests with a session unless this header is set.
const CSRF_HEADER = 'x-hobwork-csrf'

export class RouteError extends Error {
  status: number
  // The parsed JSON body, or the text, of the error response.
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.body = body
  }
}

// "spools/42" or "/spools/42" -> "/api/spools/42".
export function routeUrl(path: string): string {
  return `/api/${path.replace(/^\/+/, '')}`
}

// fetch() for a route, with the session and the CSRF header.
export function callRoute(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set(CSRF_HEADER, '1')
  return fetch(routeUrl(path), { credentials: 'same-origin', ...init, headers })
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await callRoute(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
  const text = await res.text()
  let data: unknown = text || undefined
  if (text && res.headers.get('content-type')?.includes('json')) {
    try {
      data = JSON.parse(text)
    } catch {
      // Leave it as text.
    }
  }
  if (!res.ok) {
    const error = typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : undefined
    throw new RouteError(res.status, error ?? `${method} ${routeUrl(path)} answered ${res.status}`, data)
  }
  return data as T
}

// Calls a route and returns its JSON (or text) answer, undefined for an empty
// one. Throws a RouteError for error statuses.
export const api = {
  get: <T = unknown>(path: string) => send<T>('GET', path),
  post: <T = unknown>(path: string, body?: unknown) => send<T>('POST', path, body),
  put: <T = unknown>(path: string, body?: unknown) => send<T>('PUT', path, body),
  patch: <T = unknown>(path: string, body?: unknown) => send<T>('PATCH', path, body),
  delete: <T = unknown>(path: string) => send<T>('DELETE', path),
}

export type UploadProgress = { loaded: number; total: number }

export type UploadOptions = {
  // Called after each part with the bytes stored so far.
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
  // The Content-Type that `types` in hobwork.json is checked against. Default: the Blob's type.
  type?: string
}

// A part that fails to send (a dropped connection, a host restart) is sent
// again this many times, from where the host says the upload stands.
const UPLOAD_RETRIES = 3

async function uploadAnswer<T>(res: Response, what: string): Promise<T> {
  const text = await res.text()
  let data: unknown = text || undefined
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    // Leave it as text.
  }
  if (!res.ok) {
    const error = typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : undefined
    throw new RouteError(res.status, error ?? `${what} answered ${res.status}`, data)
  }
  return data as T
}

function uploadFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set(CSRF_HEADER, '1')
  return fetch(url, { credentials: 'same-origin', ...init, headers })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

// Stores `file` at `path` in the hob's files (ctx.files) straight from the
// browser, without a handler and past the route body limit. `path` must be
// under a prefix of `uploads` in hobwork.json, which also sets the size limit,
// the accepted types and the triggers that run once the file is in. The file
// goes in parts, and a part that fails is sent again. Throws RouteError.
export async function upload(path: string, file: Blob, options: UploadOptions = {}): Promise<UploadedFile> {
  const { signal, onProgress } = options
  const type = options.type ?? (file.type || undefined)
  let status = await uploadAnswer<UploadStatus>(
    await uploadFetch(UPLOADS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, size: file.size, ...(type ? { type } : {}) }),
      signal,
    }),
    'Starting the upload',
  )
  const statusUrl = `${UPLOADS_PATH}/${encodeURIComponent(status.id)}`
  onProgress?.({ loaded: 0, total: file.size })
  let failures = 0
  for (;;) {
    const end = Math.min(file.size, status.received + status.chunkBytes)
    let res: Response
    try {
      res = await uploadFetch(`${statusUrl}?offset=${status.received}`, { method: 'PUT', body: file.slice(status.received, end), signal })
    } catch (err) {
      if (signal?.aborted || ++failures > UPLOAD_RETRIES) throw err
      await delay(1000 * failures, signal)
      status = await uploadAnswer<UploadStatus>(await uploadFetch(statusUrl, { signal }), 'Checking the upload')
      continue
    }
    // The host has more or less than this part assumed, after a part whose answer was lost.
    if (res.status === 409 && ++failures <= UPLOAD_RETRIES) {
      await res.body?.cancel()
      status = await uploadAnswer<UploadStatus>(await uploadFetch(statusUrl, { signal }), 'Checking the upload')
      continue
    }
    const answer = await uploadAnswer<UploadStatus | { done: true; file: UploadedFile }>(res, 'Uploading')
    failures = 0
    if ('done' in answer) {
      onProgress?.({ loaded: file.size, total: file.size })
      return answer.file
    }
    status = answer
    onProgress?.({ loaded: status.received, total: file.size })
  }
}

// The hob's files, from its UI.
export const files = { upload }
