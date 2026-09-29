import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { Allowlist } from '../config.ts'
import { json, parseCookies, setCookie } from '../http.ts'
import { createSession, deleteSession, findSessionRecord, SESSION_TTL_SECONDS, type SessionRecord } from './sessions.ts'
import { isAllowed, type User } from './users.ts'

// A request with a custom header cannot be sent cross-site without a CORS
// preflight, which the host never allows. Together with SameSite=Lax cookies
// and the Origin check this stops CSRF on cookie-authenticated requests.
export const CSRF_HEADER = 'x-hobwork-csrf'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export type Auth = ReturnType<typeof createAuth>

export function createAuth(options: { db: DatabaseSync; publicUrl: string; allowlist: Allowlist }) {
  const { db, publicUrl, allowlist } = options
  const secure = publicUrl.startsWith('https:')
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure,
  // host-only and on "/", so a sibling subdomain cannot plant one.
  const cookieName = secure ? '__Host-hobwork_session' : 'hobwork_session'

  function sessionToken(req: IncomingMessage): string | undefined {
    return parseCookies(req.headers.cookie).get(cookieName)
  }

  function currentSession(req: IncomingMessage): SessionRecord | undefined {
    const token = sessionToken(req)
    if (!token) return undefined
    const session = findSessionRecord(db, token)
    // Checked on every request so removing someone from the allowlist signs them out.
    return session && isAllowed(db, allowlist, session.user) ? session : undefined
  }

  function currentUser(req: IncomingMessage): User | undefined {
    return currentSession(req)?.user
  }

  function csrfError(req: IncomingMessage): string | undefined {
    if (SAFE_METHODS.has(req.method ?? 'GET')) return undefined
    if (req.headers[CSRF_HEADER] !== '1') return `Send the header "${CSRF_HEADER}: 1" with this request`
    const origin = req.headers.origin
    if (origin !== undefined && origin !== publicUrl) return 'The request comes from another site'
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'The request comes from another site'
    return undefined
  }

  return {
    cookieName,
    secure,
    currentUser,
    currentSession,

    // Writes a 401 or 403 and returns undefined when the request may not go on.
    // State-changing methods are also checked for CSRF.
    requireUser(req: IncomingMessage, res: ServerResponse): User | undefined {
      const user = currentUser(req)
      if (!user) {
        json(res, 401, { error: 'Sign in to continue' })
        return undefined
      }
      const error = csrfError(req)
      if (error) {
        json(res, 403, { error })
        return undefined
      }
      return user
    },

    // For handlers that write their own error response: the signed-in user,
    // or undefined when there is none or the request fails the CSRF check.
    sessionUser(req: IncomingMessage): User | undefined {
      return csrfError(req) ? undefined : currentUser(req)
    },

    checkCsrf(req: IncomingMessage, res: ServerResponse): boolean {
      const error = csrfError(req)
      if (error) json(res, 403, { error })
      return !error
    },

    signIn(res: ServerResponse, user: User) {
      setCookie(res, cookieName, createSession(db, user.id), { maxAge: SESSION_TTL_SECONDS, secure })
    },

    signOut(req: IncomingMessage, res: ServerResponse) {
      const token = sessionToken(req)
      if (token) deleteSession(db, token)
      setCookie(res, cookieName, '', { maxAge: 0, secure })
    },
  }
}
