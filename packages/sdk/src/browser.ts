// Client for hob UIs calling their own routes with the signed-in user's
// session. Hobwork serves each hob UI at the root of its own origin, and
// the hob's routes under /api/ on that origin.

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
