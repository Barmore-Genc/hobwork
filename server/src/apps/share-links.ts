import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedAgent } from '../agents.ts'
import type { AppScope } from './sessions.ts'

// Long enough to come back to a chat about a change, short enough that a link
// pasted somewhere does not open the app for good.
export const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

// The prefix tells a share link token apart from agent and OAuth tokens in a
// bearer header and in logs a person pastes.
const TOKEN_PREFIX = 'hws_'

export type ShareLink = { readOnly: boolean; expiresAt: string }

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isShareToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX)
}

export function createShareLink(
  db: DatabaseSync,
  agent: AuthenticatedAgent,
  scope: AppScope,
  now = Date.now(),
): { token: string; expiresAt: string } {
  pruneShareLinks(db, now)
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const expiresAt = new Date(now + SHARE_LINK_TTL_MS).toISOString()
  const credential = agent.credential
  db.prepare(
    `INSERT INTO app_share_links (token_hash, project_id, branch, agent_id, token_id, grant_id, read_only, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hash(token),
    scope.projectId,
    scope.branch,
    agent.id,
    credential?.kind === 'token' ? credential.id : null,
    credential?.kind === 'grant' ? credential.id : null,
    agent.access.readOnly ? 1 : 0,
    expiresAt,
  )
  return { token, expiresAt }
}

// A link opens only the origin it was made for, until it expires or the
// credential that made it is revoked.
export function findShareLink(db: DatabaseSync, token: string, scope: AppScope, now = Date.now()): ShareLink | undefined {
  if (!isShareToken(token)) return undefined
  const row = db
    .prepare(
      `SELECT l.read_only, l.expires_at FROM app_share_links l
       LEFT JOIN agent_tokens t ON t.id = l.token_id
       LEFT JOIN oauth_grants g ON g.id = l.grant_id
       WHERE l.token_hash = ? AND l.project_id = ? AND l.branch IS ? AND l.expires_at > ?
         AND t.revoked_at IS NULL AND g.revoked_at IS NULL`,
    )
    .get(hash(token), scope.projectId, scope.branch, new Date(now).toISOString())
  return row ? { readOnly: row.read_only === 1, expiresAt: String(row.expires_at) } : undefined
}

export function pruneShareLinks(db: DatabaseSync, now = Date.now()) {
  db.prepare('DELETE FROM app_share_links WHERE expires_at <= ?').run(new Date(now).toISOString())
}
