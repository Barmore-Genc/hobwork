import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from '../http.ts'
import type { Auth } from './auth.ts'
import { CALLBACK_PATH, LOGIN_PATH, type OidcLogin } from './oidc.ts'

export const AUTH_PREFIX = '/auth/'
export const SESSION_PATH = '/api/session'
const LOGOUT_PATH = '/auth/logout'

// Handles sign-in, sign-out and the session endpoint the web UI starts from.
// Returns false for paths it does not own.
export function createAuthRoutes(options: { auth: Auth; oidc?: OidcLogin }) {
  const { auth, oidc } = options

  return async (req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams) => {
    if (pathname === SESSION_PATH && req.method === 'GET') {
      const user = auth.currentUser(req)
      json(res, 200, {
        user: user ? { name: user.name, email: user.email } : null,
        signIn: { oidc: oidc ? { name: oidc.name } : null },
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
    if (pathname === LOGOUT_PATH && req.method === 'POST') {
      if (!auth.checkCsrf(req, res)) return true
      auth.signOut(req, res)
      res.writeHead(204).end()
      return true
    }
    return false
  }
}
