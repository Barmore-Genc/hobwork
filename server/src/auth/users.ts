import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import type { Allowlist } from '../config.ts'

export type User = { id: number; name: string; email: string | null }

export type OidcIdentity = {
  issuer: string
  subject: string
  name: string
  // Only set when the provider says the address is verified.
  email: string | null
}

function toUser(row: Record<string, unknown>): User {
  return { id: Number(row.id), name: String(row.name), email: row.email === null ? null : String(row.email) }
}

export function getUser(db: DatabaseSync, id: number): User | undefined {
  const row = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(id)
  return row ? toUser(row) : undefined
}

export function isAllowed(db: DatabaseSync, allowlist: Allowlist, user: User): boolean {
  if (allowlist.everyone) return true
  if (user.email && allowlist.emails.includes(user.email.toLowerCase())) return true
  if (allowlist.subjects.length === 0) return false
  return db
    .prepare('SELECT subject FROM user_identities WHERE user_id = ?')
    .all(user.id)
    .some((row) => allowlist.subjects.includes(String(row.subject)))
}

function identityAllowed(allowlist: Allowlist, identity: OidcIdentity): boolean {
  return (
    allowlist.everyone === true ||
    allowlist.subjects.includes(identity.subject) ||
    (identity.email !== null && allowlist.emails.includes(identity.email.toLowerCase()))
  )
}

export function findUserByEmail(db: DatabaseSync, email: string): User | undefined {
  const row = db.prepare('SELECT id, name, email FROM users WHERE lower(email) = lower(?) ORDER BY id LIMIT 1').get(email)
  return row ? toUser(row) : undefined
}

// Returns undefined when the identity is not on the allowlist. Name and email
// follow the provider, so changes there show up on the next sign-in.
export function signInOidcUser(db: DatabaseSync, allowlist: Allowlist, identity: OidcIdentity): User | undefined {
  if (!identityAllowed(allowlist, identity)) return undefined
  // A new identity with a verified email joins the user who already has that
  // email, for example one who started with a sign-in link and a passkey.
  const existing =
    db.prepare('SELECT user_id FROM user_identities WHERE issuer = ? AND subject = ?').get(identity.issuer, identity.subject) ??
    linkIdentityByEmail(db, identity)
  if (existing) {
    const row = db
      .prepare(
        `UPDATE users SET name = ?, email = ?, last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? RETURNING id, name, email`,
      )
      .get(identity.name, identity.email, Number(existing.user_id))
    if (!row) throw new Error('User of an identity is missing')
    return toUser(row)
  }
  db.exec('BEGIN')
  try {
    const row = db
      .prepare(
        `INSERT INTO users (name, email, last_login_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         RETURNING id, name, email`,
      )
      .get(identity.name, identity.email)
    if (!row) throw new Error('User insert returned no row')
    const user = toUser(row)
    db.prepare('INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, ?, ?)').run(
      user.id,
      identity.issuer,
      identity.subject,
    )
    db.exec('COMMIT')
    return user
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function linkIdentityByEmail(db: DatabaseSync, identity: OidcIdentity): { user_id: number } | undefined {
  if (!identity.email) return undefined
  const user = findUserByEmail(db, identity.email)
  if (!user) return undefined
  db.prepare('INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, ?, ?)').run(
    user.id,
    identity.issuer,
    identity.subject,
  )
  return { user_id: user.id }
}

// For people without an identity provider: the sign-in-link command vouches
// for the email address, which must be on the allowlist.
export function findOrCreateEmailUser(db: DatabaseSync, allowlist: Allowlist, email: string, name?: string): User | undefined {
  if (!allowlist.everyone && !allowlist.emails.includes(email.toLowerCase())) return undefined
  const existing = findUserByEmail(db, email)
  if (existing) return existing
  const row = db
    .prepare('INSERT INTO users (name, email) VALUES (?, ?) RETURNING id, name, email')
    .get(name?.trim() || email.split('@')[0]!, email)
  if (!row) throw new Error('User insert returned no row')
  return toUser(row)
}

export function markSignedIn(db: DatabaseSync, userId: number) {
  db.prepare(`UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(userId)
}

// The WebAuthn user handle, created on first use.
export function webauthnUserId(db: DatabaseSync, userId: number): string {
  const row = db.prepare('SELECT webauthn_id FROM users WHERE id = ?').get(userId)
  if (row?.webauthn_id) return String(row.webauthn_id)
  const id = randomBytes(32).toString('base64url')
  db.prepare('UPDATE users SET webauthn_id = ? WHERE id = ?').run(id, userId)
  return id
}
