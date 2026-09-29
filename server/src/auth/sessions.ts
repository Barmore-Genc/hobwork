import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { getUser, type User } from './users.ts'

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

// Session tokens are 256 random bits, so an unsalted hash is enough to make a
// leaked DB useless.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSession(db: DatabaseSync, userId: number, now = Date.now()): string {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString())
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    userId,
    hashToken(token),
    new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
  )
  return token
}

export function findSession(db: DatabaseSync, token: string, now = Date.now()): User | undefined {
  const row = db
    .prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hashToken(token), new Date(now).toISOString())
  return row ? getUser(db, Number(row.user_id)) : undefined
}

export function deleteSession(db: DatabaseSync, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}
