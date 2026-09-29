import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Auth } from '../auth/auth.ts'
import type { User } from '../auth/users.ts'
import { HttpError, json } from '../http.ts'

export type ApiRoute = {
  method: string
  pattern: RegExp
  handle: (ctx: {
    req: IncomingMessage
    res: ServerResponse
    user: User
    params: string[]
    query: URLSearchParams
  }) => Promise<void> | void
}

// Routes for signed-in users only, so agent tokens get a 401. Returns false
// for paths no route matches, so later handlers can take them. A path that
// matches with another method falls through too, since another table may
// serve that method.
export function userRoutes(auth: Auth, routes: ApiRoute[]) {
  return async (req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<boolean> => {
    let route: ApiRoute | undefined
    let match: RegExpExecArray | null = null
    for (const candidate of routes) {
      if (candidate.method !== req.method) continue
      match = candidate.pattern.exec(pathname)
      if (match) {
        route = candidate
        break
      }
    }
    if (!route || !match) return false
    let params: string[]
    try {
      params = match.slice(1).map((p) => decodeURIComponent(p))
    } catch {
      json(res, 400, { error: 'Malformed path' })
      return true
    }
    const user = auth.requireUser(req, res)
    if (!user) return true
    try {
      await route.handle({ req, res, user, params, query })
    } catch (err) {
      if (err instanceof HttpError) json(res, err.status, { error: err.message })
      else {
        console.error(`${req.method} ${pathname} failed`, err)
        if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the Hobwork server' })
      }
    }
    return true
  }
}
