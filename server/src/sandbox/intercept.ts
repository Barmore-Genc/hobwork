import { hostMatches } from './egress.ts'
import { INTERNAL_HOST, type InternalHandler, type Interceptor, type Upstream } from './sandbox.ts'

// Connection-level headers that fetch sets itself.
const HOP_BY_HOP = ['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'expect', 'content-length']
// fetch decodes the body, so these no longer describe it.
const DECODED = ['content-encoding', 'content-length', 'transfer-encoding']

export function upstreamFetch(
  applySecrets: (request: Request) => Request | Promise<Request>,
  fetchImpl: typeof fetch = fetch,
): Upstream {
  return async (request) => {
    const ready = await applySecrets(request)
    const headers = new Headers(ready.headers)
    for (const name of HOP_BY_HOP) headers.delete(name)
    const hasBody = ready.method !== 'GET' && ready.method !== 'HEAD'
    const response = await fetchImpl(ready.url, {
      method: ready.method,
      headers,
      body: hasBody ? await ready.arrayBuffer() : undefined,
      redirect: 'manual',
    })
    const out = new Headers(response.headers)
    for (const name of DECODED) out.delete(name)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out })
  }
}

// The sandbox's request hook: hobwork.internal goes to the internal handler,
// allowed requests to intercepted hosts to the interceptor, and everything
// else on to Gondolin's own checks (undefined).
export function requestHook(options: {
  internal?: InternalHandler
  intercept?: Interceptor
  egress: string[]
  upstream: Upstream
}): ((request: Request) => Promise<Response | undefined>) | undefined {
  const { internal, intercept, egress, upstream } = options
  if (!internal && !intercept) return undefined
  return async (request) => {
    const { hostname } = new URL(request.url)
    if (hostname === INTERNAL_HOST) return internal ? internal(request) : undefined
    if (intercept && hostMatches(hostname, intercept.hosts) && hostMatches(hostname, egress)) {
      return intercept.handle(request, upstream)
    }
    return undefined
  }
}
