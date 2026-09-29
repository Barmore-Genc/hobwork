// Routes from hobwork.json: "GET /spools" answers GET /p/<project>/api/spools.
// A segment starting with `:` matches any one segment and is passed to the
// handler in ctx.params. Static segments win over parameters.

export type Route = {
  key: string
  method: string
  segments: string[]
  handler: string
}

export type RouteMatch =
  | { route: Route; params: Record<string, string> }
  | { methodNotAllowed: string[] }
  | undefined

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function parseRoutes(routes: Record<string, { handler: string }> | undefined): Route[] {
  const parsed = Object.entries(routes ?? {}).map(([key, { handler }]) => {
    const [method = '', path = '/'] = key.trim().split(/\s+/)
    return { key, method: method.toUpperCase(), segments: splitPath(path), handler }
  })
  const staticCount = (route: Route) => route.segments.filter((s) => !s.startsWith(':')).length
  return parsed.sort((a, b) => staticCount(b) - staticCount(a))
}

function matchSegments(route: Route, segments: string[]): Record<string, string> | undefined {
  if (route.segments.length !== segments.length) return undefined
  const params: Record<string, string> = {}
  for (const [i, pattern] of route.segments.entries()) {
    const segment = segments[i]!
    if (pattern.startsWith(':')) {
      try {
        params[pattern.slice(1)] = decodeURIComponent(segment)
      } catch {
        return undefined
      }
    } else if (pattern !== segment) return undefined
  }
  return params
}

// `path` is the part after /p/<project>/api, without the query string.
export function matchRoute(routes: Route[], method: string, path: string): RouteMatch {
  const segments = splitPath(path)
  const wanted = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const allowed: string[] = []
  for (const route of routes) {
    const params = matchSegments(route, segments)
    if (!params) continue
    if (route.method === wanted) return { route, params }
    allowed.push(route.method)
  }
  return allowed.length ? { methodNotAllowed: allowed } : undefined
}
