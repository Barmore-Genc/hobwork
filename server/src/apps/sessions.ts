import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Allowlist } from '../config.ts'
import { getUser, isAllowed, type User } from '../auth/users.ts'

// A code moves a Hobwork session to an app origin through the browser's
// address bar, so it is single-use and short-lived. The app session it turns
// into is bound to one project (and branch) and to the Hobwork session.
export const CODE_TTL_MS = 60_000

export type AppScope = { projectId: number; branch: string | null }

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createAppCode(db: DatabaseSync, sessionId: number, scope: AppScope, now = Date.now()): string {
  db.prepare('DELETE FROM app_codes WHERE expires_at <= ?').run(new Date(now).toISOString())
  const code = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO app_codes (code_hash, session_id, project_id, branch, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    hash(code),
    sessionId,
    scope.projectId,
    scope.branch,
    new Date(now + CODE_TTL_MS).toISOString(),
  )
  return code
}

// Uses up the code and returns a new app session token with the expiry of the
// Hobwork session it came from. A code for another project or branch is used
// up too and gives nothing.
export function redeemAppCode(
  db: DatabaseSync,
  code: string,
  scope: AppScope,
  now = Date.now(),
): { token: string; expiresAt: string } | undefined {
  const at = new Date(now).toISOString()
  const row = db
    .prepare('DELETE FROM app_codes WHERE code_hash = ? AND expires_at > ? RETURNING session_id, project_id, branch')
    .get(hash(code), at)
  if (!row || Number(row.project_id) !== scope.projectId || row.branch !== scope.branch) return undefined
  const session = db.prepare('SELECT expires_at FROM sessions WHERE id = ? AND expires_at > ?').get(Number(row.session_id), at)
  if (!session) return undefined
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO app_sessions (token_hash, session_id, project_id, branch) VALUES (?, ?, ?, ?)').run(
    hash(token),
    Number(row.session_id),
    scope.projectId,
    scope.branch,
  )
  return { token, expiresAt: String(session.expires_at) }
}

// `deviceId` is set when the Hobwork session is a paired app's web view.
export type AppSession = { user: User; deviceId: number | null }

// The user of an app session, only for the scope it was made for and only
// while its Hobwork session lasts and the user is still allowed.
export function findAppSession(
  db: DatabaseSync,
  allowlist: Allowlist,
  token: string,
  scope: AppScope,
  now = Date.now(),
): AppSession | undefined {
  const row = db
    .prepare(
      `SELECT s.user_id, s.device_id FROM app_sessions a JOIN sessions s ON s.id = a.session_id
       WHERE a.token_hash = ? AND a.project_id = ? AND a.branch IS ? AND s.expires_at > ?`,
    )
    .get(hash(token), scope.projectId, scope.branch, new Date(now).toISOString())
  const user = row && getUser(db, Number(row.user_id))
  if (!user || !isAllowed(db, allowlist, user)) return undefined
  return { user, deviceId: row.device_id === null ? null : Number(row.device_id) }
}
