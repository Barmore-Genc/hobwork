import type { DatabaseSync } from 'node:sqlite'
import type { Person } from '../../packages/sdk/src/people.ts'
import { isTimeZone } from '../../packages/sdk/src/time.ts'
import { isAllowed, type User } from './auth/users.ts'
import { publishChange } from './changes.ts'
import type { Allowlist } from './config.ts'

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// `manual`: the person chose timeZone in Settings, so reports leave it alone.
export type TimeZoneSetting = { timeZone: string | null; manual: boolean }

export function timeZoneSetting(db: DatabaseSync, userId: number): TimeZoneSetting {
  const row = db.prepare('SELECT time_zone, time_zone_manual FROM users WHERE id = ?').get(userId)
  return { timeZone: row?.time_zone == null ? null : String(row.time_zone), manual: Number(row?.time_zone_manual ?? 0) === 1 }
}

// A zone the person chose, or null to follow what their app and browser report.
export function setTimeZone(db: DatabaseSync, userId: number, timeZone: string | null): void {
  if (timeZone !== null && !isTimeZone(timeZone)) throw new RangeError(`"${timeZone}" is not a known time zone`)
  if (timeZone === null) db.prepare('UPDATE users SET time_zone_manual = 0 WHERE id = ?').run(userId)
  else db.prepare('UPDATE users SET time_zone = ?, time_zone_manual = 1 WHERE id = ?').run(timeZone, userId)
  publishChange(db, { kind: 'people' })
}

// The zone an app or browser of the person is in. True when it was stored.
export function reportTimeZone(db: DatabaseSync, userId: number, timeZone: unknown): boolean {
  if (!isTimeZone(timeZone)) return false
  const result = db
    .prepare('UPDATE users SET time_zone = ? WHERE id = ? AND time_zone_manual = 0 AND time_zone IS NOT ?')
    .run(timeZone, userId, timeZone)
  if (Number(result.changes) === 0) return false
  publishChange(db, { kind: 'people' })
  return true
}

function toPerson(row: Record<string, unknown>): Person {
  const zone = row.time_zone == null ? undefined : String(row.time_zone)
  return {
    id: Number(row.id),
    name: String(row.name),
    email: row.email === null ? null : String(row.email),
    // A zone this host's Intl no longer knows falls back like a missing one.
    timeZone: zone !== undefined && isTimeZone(zone) ? zone : hostTimeZone(),
  }
}

export function personOf(db: DatabaseSync, user: User): Person {
  const row = db.prepare('SELECT id, name, email, time_zone FROM users WHERE id = ?').get(user.id)
  return toPerson(row ?? { ...user, time_zone: null })
}

// People who may sign in, by name.
export function listPeople(db: DatabaseSync, allowlist: Allowlist): Person[] {
  return db
    .prepare('SELECT id, name, email, time_zone FROM users ORDER BY name, id')
    .all()
    .filter((row) => isAllowed(db, allowlist, { id: Number(row.id), name: String(row.name), email: row.email === null ? null : String(row.email) }))
    .map(toPerson)
}

export function getPerson(db: DatabaseSync, allowlist: Allowlist, id: number): Person | undefined {
  const row = db.prepare('SELECT id, name, email, time_zone FROM users WHERE id = ?').get(id)
  if (!row) return undefined
  const user = { id: Number(row.id), name: String(row.name), email: row.email === null ? null : String(row.email) }
  return isAllowed(db, allowlist, user) ? toPerson(row) : undefined
}
