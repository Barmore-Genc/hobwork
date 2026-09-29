import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { getUser, markSignedIn, type User } from './users.ts'

export const LINK_PATH = '/auth/link'
export const LINK_TTL_MINUTES = 15

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSignInLink(db: DatabaseSync, publicUrl: string, userId: number, now = Date.now()): string {
  db.prepare('DELETE FROM sign_in_links WHERE expires_at <= ?').run(new Date(now).toISOString())
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sign_in_links (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    new Date(now + LINK_TTL_MINUTES * 60_000).toISOString(),
  )
  return `${publicUrl}${LINK_PATH}?token=${token}`
}

// Each link works once.
export function useSignInLink(db: DatabaseSync, token: string, now = Date.now()): User | undefined {
  const row = db
    .prepare('DELETE FROM sign_in_links WHERE token_hash = ? AND expires_at > ? RETURNING user_id')
    .get(hashToken(token), new Date(now).toISOString())
  if (!row) return undefined
  markSignedIn(db, Number(row.user_id))
  return getUser(db, Number(row.user_id))
}
