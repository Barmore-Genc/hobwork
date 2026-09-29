import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { Allowlist } from '../config.ts'
import { json, redirect } from '../http.ts'
import type { Auth } from './auth.ts'
import { LINK_PATH, useSignInLink } from './links.ts'
import { CALLBACK_PATH, LOGIN_PATH, type OidcLogin } from './oidc.ts'
import type { Passkeys } from './passkeys.ts'
import { isAllowed } from './users.ts'

export const AUTH_PREFIX = '/auth/'
export const SESSION_PATH = '/api/session'
const LOGOUT_PATH = '/auth/logout'

// Handles sign-in, sign-out, passkeys and the session endpoint the web UI
// starts from. Returns false for paths it does not own.
export function createAuthRoutes(options: {
  db: DatabaseSync
  allowlist: Allowlist
  auth: Auth
  oidc?: OidcLogin
  passkeys: Passkeys
}) {
  const { db, allowlist, auth, oidc, passkeys } = options

  return async (req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams) => {
    if (pathname === SESSION_PATH && req.method === 'GET') {
      const user = auth.currentUser(req)
      json(res, 200, {
        user: user ? { name: user.name, email: user.email } : null,
        signIn: { oidc: oidc ? { name: oidc.name } : null, passkey: true },
      })
      return true
    }
    if (pathname === LOGIN_PATH && req.method === 'GET' && oidc) {
      await oidc.login(res, search)
      return true
    }
    if (pathname === CALLBACK_PATH && req.method === 'GET' && oidc) {
      await oidc.callback(req, res)
      return true
    }
    if (pathname === LINK_PATH && req.method === 'GET') {
      // A link followed from a page would let that page sign the browser in to
      // the link author's account (login CSRF). Typed links and links from
      // mail or chat apps are sent as "none".
      const site = req.headers['sec-fetch-site']
      if (site !== undefined && site !== 'none') {
        json(res, 403, { error: 'Open this link from your address bar or a message, not from another page' })
        return true
      }
      const user = useSignInLink(db, search.get('token') ?? '')
      if (!user || !isAllowed(db, allowlist, user)) {
        redirect(res, '/login?error=link_expired')
        return true
      }
      auth.signIn(res, user)
      redirect(res, '/settings')
      return true
    }
    if (await passkeys.handle(req, res, pathname)) return true
    if (pathname === LOGOUT_PATH && req.method === 'POST') {
      if (!auth.checkCsrf(req, res)) return true
      auth.signOut(req, res)
      res.writeHead(204).end()
      return true
    }
    return false
  }
}
