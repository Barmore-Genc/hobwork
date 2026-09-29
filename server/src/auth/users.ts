import type { DatabaseSync } from 'node:sqlite'
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
  if (user.email && allowlist.emails.includes(user.email.toLowerCase())) return true
  if (allowlist.subjects.length === 0) return false
  return db
    .prepare('SELECT subject FROM user_identities WHERE user_id = ?')
    .all(user.id)
    .some((row) => allowlist.subjects.includes(String(row.subject)))
}

function identityAllowed(allowlist: Allowlist, identity: OidcIdentity): boolean {
  return (
    allowlist.subjects.includes(identity.subject) ||
    (identity.email !== null && allowlist.emails.includes(identity.email.toLowerCase()))
  )
}

// Returns undefined when the identity is not on the allowlist. Name and email
// follow the provider, so changes there show up on the next sign-in.
export function signInOidcUser(db: DatabaseSync, allowlist: Allowlist, identity: OidcIdentity): User | undefined {
  if (!identityAllowed(allowlist, identity)) return undefined
  const existing = db
    .prepare('SELECT user_id FROM user_identities WHERE issuer = ? AND subject = ?')
    .get(identity.issuer, identity.subject)
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
