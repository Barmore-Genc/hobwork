import type { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import { publishChange } from '../changes.ts'
import { hashSecret, newSecret, s256 } from '../oauth/secrets.ts'

export const DEVICE_TOKEN_PREFIX = 'hwd_'
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const WEB_SESSION_LINK_TTL_MS = 60 * 1000
export const NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_DEVICE_NAME = 40
// Custom-scheme redirect of apps that were not built with the host's domain in
// Associated Domains.
export const PAIRING_REDIRECT_URI = 'hobwork://paired'
export const PAIRED_PATH = '/devices/paired'

// A universal link the app claims, so no other app can catch the pairing code
// the way it could with a custom scheme.
export function pairedUniversalLink(publicUrl: string): string {
  return `${publicUrl}${PAIRED_PATH}`
}

export const PLATFORMS = ['ios', 'macos'] as const
export type Platform = (typeof PLATFORMS)[number]
export type PushEnvironment = 'sandbox' | 'production'
export type Push = { token: string; environment: PushEnvironment }

export type Device = {
  id: number
  userId: number
  owner: string
  ownerEmail: string | null
  name: string
  platform: Platform
  capabilities: string[]
  appVersion: string | null
  push: Push | null
  createdAt: string
  lastSeenAt: string | null
  lastActiveAt: string | null
}

// Names scripts use: ctx.device("kaan-iphone").
const NAME = /^[a-z0-9][a-z0-9-]*$/

export class DeviceStoreError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)
}

export function deviceNameError(name: string): string | undefined {
  if (!name) return 'Give the device a name'
  if (name.length > MAX_DEVICE_NAME) return `Use at most ${MAX_DEVICE_NAME} characters`
  if (!NAME.test(name)) return 'Use lowercase letters, digits and hyphens, starting with a letter or digit'
  return undefined
}

// "Kaan's iPhone" becomes "kaans-iphone".
export function slugifyDeviceName(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_DEVICE_NAME - 3)
    .replace(/-+$/, '')
  return slug || 'device'
}

export function deviceNameTaken(db: DatabaseSync, name: string, exceptId?: number): boolean {
  return db.prepare('SELECT 1 FROM devices WHERE name = ? AND revoked_at IS NULL AND id != ?').get(name, exceptId ?? -1) !== undefined
}

// "kaans-iphone", then "kaans-iphone-2", ... so a suggested name is free.
export function freeDeviceName(db: DatabaseSync, base: string): string {
  const slug = slugifyDeviceName(base)
  if (!deviceNameTaken(db, slug)) return slug
  for (let n = 2; ; n++) {
    const name = `${slug}-${n}`
    if (!deviceNameTaken(db, name)) return name
  }
}

function toDevice(row: Record<string, unknown>): Device {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    owner: String(row.owner),
    ownerEmail: row.owner_email === null ? null : String(row.owner_email),
    name: String(row.name),
    platform: String(row.platform) as Platform,
    capabilities: JSON.parse(String(row.capabilities)) as string[],
    appVersion: row.app_version === null ? null : String(row.app_version),
    push:
      row.push_token === null
        ? null
        : { token: String(row.push_token), environment: String(row.push_environment) as PushEnvironment },
    createdAt: String(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
    lastActiveAt: row.last_active_at === null ? null : String(row.last_active_at),
  }
}

const SELECT_DEVICE = `SELECT d.*, u.name AS owner, u.email AS owner_email FROM devices d JOIN users u ON u.id = d.user_id`

export function listDevices(db: DatabaseSync): Device[] {
  return db.prepare(`${SELECT_DEVICE} WHERE d.revoked_at IS NULL ORDER BY d.name`).all().map(toDevice)
}

export function getDevice(db: DatabaseSync, id: number): Device | undefined {
  const row = db.prepare(`${SELECT_DEVICE} WHERE d.id = ? AND d.revoked_at IS NULL`).get(id)
  return row ? toDevice(row) : undefined
}

export function findDeviceByName(db: DatabaseSync, name: string): Device | undefined {
  const row = db.prepare(`${SELECT_DEVICE} WHERE d.name = ? AND d.revoked_at IS NULL`).get(name)
  return row ? toDevice(row) : undefined
}

export function verifyDeviceToken(db: DatabaseSync, token: string): Device | undefined {
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return undefined
  const row = db.prepare(`${SELECT_DEVICE} WHERE d.token_hash = ? AND d.revoked_at IS NULL`).get(hashSecret(token))
  return row ? toDevice(row) : undefined
}

export type PairingRequest = { userId: number; name: string; platform: Platform; codeChallenge: string }

// The code the app exchanges with its PKCE verifier. Single use, 5 minutes.
export function createPairingCode(db: DatabaseSync, request: PairingRequest, now = Date.now()): string {
  db.prepare('DELETE FROM device_pairing_codes WHERE expires_at <= ?').run(iso(now))
  const code = randomBytes(32).toString('base64url')
  db.prepare(
    'INSERT INTO device_pairing_codes (code_hash, user_id, name, platform, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(hashSecret(code), request.userId, request.name, request.platform, request.codeChallenge, iso(now + PAIRING_CODE_TTL_MS))
  return code
}

// Creates the device and its token. The code is deleted by the statement that
// reads it, so a wrong verifier also uses it up: a stolen code gets one guess.
export function exchangePairingCode(
  db: DatabaseSync,
  code: string,
  verifier: string,
  now = Date.now(),
): { device: Device; token: string } {
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db
      .prepare('DELETE FROM device_pairing_codes WHERE code_hash = ? RETURNING user_id, name, platform, code_challenge, expires_at')
      .get(hashSecret(code))
    if (!row || String(row.expires_at) <= iso(now)) {
      throw new DeviceStoreError(400, 'This pairing code is unknown, expired or was already used. Pair the device again.')
    }
    if (s256(verifier) !== String(row.code_challenge)) {
      throw new DeviceStoreError(400, 'The code verifier does not match the code challenge. Pair the device again.')
    }
    // The name was free on approval, but another device may have taken it since.
    const name = deviceNameTaken(db, String(row.name)) ? freeDeviceName(db, String(row.name)) : String(row.name)
    const token = newSecret(DEVICE_TOKEN_PREFIX)
    const inserted = db
      .prepare('INSERT INTO devices (user_id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(Number(row.user_id), name, String(row.platform), hashSecret(token), iso(now))
    db.exec('COMMIT')
    publishChange(db, { kind: 'devices' })
    return { device: getDevice(db, Number(inserted!.id))!, token }
  } catch (err) {
    // A failed exchange keeps the deleted code deleted.
    db.exec(err instanceof DeviceStoreError ? 'COMMIT' : 'ROLLBACK')
    throw err
  }
}

export function renameDevice(db: DatabaseSync, id: number, name: string): Device {
  const error = deviceNameError(name)
  if (error) throw new DeviceStoreError(400, error)
  if (deviceNameTaken(db, name, id)) throw new DeviceStoreError(409, `A device called "${name}" already exists`)
  const result = db.prepare('UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL').run(name, id)
  if (Number(result.changes) === 0) throw new DeviceStoreError(404, 'This device does not exist')
  publishChange(db, { kind: 'devices' })
  return getDevice(db, id)!
}

// Returns false when the device does not exist or was already revoked. The
// web view's session goes too, and with it the app sessions made from it.
export function revokeDevice(db: DatabaseSync, id: number, now = Date.now()): boolean {
  const result = db
    .prepare('UPDATE devices SET revoked_at = ?, push_token = NULL, push_environment = NULL WHERE id = ? AND revoked_at IS NULL')
    .run(iso(now), id)
  if (Number(result.changes) === 0) return false
  db.prepare('DELETE FROM device_sign_in_links WHERE device_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE device_id = ?').run(id)
  publishChange(db, { kind: 'devices' })
  return true
}

export function recordHello(
  db: DatabaseSync,
  id: number,
  hello: { appVersion: string | null; capabilities: string[]; push?: Push | null },
  now = Date.now(),
) {
  db.prepare('UPDATE devices SET app_version = ?, capabilities = ?, last_seen_at = ? WHERE id = ?').run(
    hello.appVersion,
    JSON.stringify(hello.capabilities),
    iso(now),
    id,
  )
  if (hello.push !== undefined) setPushToken(db, id, hello.push)
  publishChange(db, { kind: 'devices' })
}

export function touchDevice(db: DatabaseSync, id: number, now = Date.now()) {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(iso(now), id)
}

// last_active_at is written at most this often, since every hob API request
// from the app's web view counts.
export const ACTIVE_INTERVAL_MS = 10_000

// App events that mean someone has the device in hand. Health samples and
// Focus changes arrive without that.
const USER_EVENTS = new Set(['notifications/action', 'nfc/scanned'])

export function isUserEvent(capability: unknown, name: unknown): boolean {
  return USER_EVENTS.has(`${String(capability)}/${String(name)}`)
}

// The person used the device. Counts as seen too.
export function markDeviceActive(db: DatabaseSync, id: number, now = Date.now()) {
  db.prepare(
    `UPDATE devices SET last_active_at = ?1, last_seen_at = ?1
     WHERE id = ?2 AND revoked_at IS NULL AND (last_active_at IS NULL OR last_active_at <= ?3)`,
  ).run(iso(now), id, iso(now - ACTIVE_INTERVAL_MS))
}

// null turns push off for the device, for example when APNs says the token is
// gone. A token belongs to one app install, so a device paired again on the
// same phone takes it over from the old record.
export function setPushToken(db: DatabaseSync, id: number, push: Push | null) {
  if (push) {
    db.prepare('UPDATE devices SET push_token = NULL, push_environment = NULL WHERE push_token = ? AND id != ?').run(push.token, id)
  }
  db.prepare('UPDATE devices SET push_token = ?, push_environment = ? WHERE id = ?').run(
    push?.token ?? null,
    push?.environment ?? null,
    id,
  )
}

export function createWebSessionLink(
  db: DatabaseSync,
  publicUrl: string,
  deviceId: number,
  returnTo: string,
  now = Date.now(),
): string {
  db.prepare('DELETE FROM device_sign_in_links WHERE expires_at <= ?').run(iso(now))
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO device_sign_in_links (token_hash, device_id, return_to, expires_at) VALUES (?, ?, ?, ?)').run(
    hashSecret(token),
    deviceId,
    returnTo,
    iso(now + WEB_SESSION_LINK_TTL_MS),
  )
  return `${publicUrl}${DEVICE_LINK_PATH}?token=${token}`
}

export const DEVICE_LINK_PATH = '/auth/device'

// Each link works once, and only while its device is not revoked.
export function redeemWebSessionLink(
  db: DatabaseSync,
  token: string,
  now = Date.now(),
): { device: Device; returnTo: string } | undefined {
  const row = db
    .prepare('DELETE FROM device_sign_in_links WHERE token_hash = ? AND expires_at > ? RETURNING device_id, return_to')
    .get(hashSecret(token), iso(now))
  const device = row && getDevice(db, Number(row.device_id))
  return device && { device, returnTo: String(row.return_to) }
}

export type NotificationRecord = {
  id: string
  deviceId: number
  project: string
  actions: string[]
  data: unknown
}

export function recordNotification(
  db: DatabaseSync,
  record: { deviceId: number; projectId: number; actions: string[]; data: unknown },
  now = Date.now(),
): string {
  db.prepare('DELETE FROM device_notifications WHERE created_at <= ?').run(iso(now - NOTIFICATION_TTL_MS))
  const id = randomUUID()
  db.prepare('INSERT INTO device_notifications (id, device_id, project_id, actions, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    record.deviceId,
    record.projectId,
    JSON.stringify(record.actions),
    record.data === undefined ? null : JSON.stringify(record.data),
    iso(now),
  )
  return id
}

// An unanswered notification of this device that has this action.
export function findNotification(db: DatabaseSync, id: string, deviceId: number, action: string): NotificationRecord | undefined {
  const row = db
    .prepare(
      `SELECT n.id, n.device_id, p.name AS project, n.actions, n.data FROM device_notifications n
       JOIN projects p ON p.id = n.project_id
       WHERE n.id = ? AND n.device_id = ? AND n.answered_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(n.actions) WHERE value = ?)`,
    )
    .get(id, deviceId, action)
  if (!row) return undefined
  return {
    id: String(row.id),
    deviceId: Number(row.device_id),
    project: String(row.project),
    actions: JSON.parse(String(row.actions)) as string[],
    data: row.data === null ? undefined : JSON.parse(String(row.data)),
  }
}

// Marks the notification answered. False when it was answered before: the
// app may send an action twice (over the socket and by HTTP after a
// reconnect), and the project must see it once.
export function answerNotification(db: DatabaseSync, id: string, now = Date.now()): boolean {
  const result = db
    .prepare('UPDATE device_notifications SET answered_at = ? WHERE id = ? AND answered_at IS NULL')
    .run(iso(now), id)
  return Number(result.changes) > 0
}

export const COMMAND_TTL_MS = 10 * 60 * 1000
export const COMMAND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type CommandStatus = 'pending' | 'done' | 'failed' | 'expired'

export type CommandRecord = {
  id: string
  deviceId: number
  project: string
  invocation: number | null
  capability: string
  method: string
  args: unknown
  status: CommandStatus
  createdAt: string
  expiresAt: string
}

function toCommand(row: Record<string, unknown>): CommandRecord {
  return {
    id: String(row.id),
    deviceId: Number(row.device_id),
    project: String(row.project),
    invocation: row.invocation === null ? null : Number(row.invocation),
    capability: String(row.capability),
    method: String(row.method),
    args: JSON.parse(String(row.args)),
    status: String(row.status) as CommandStatus,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  }
}

const SELECT_COMMAND = 'SELECT c.*, p.name AS project FROM device_commands c JOIN projects p ON p.id = c.project_id'

export function recordCommand(
  db: DatabaseSync,
  command: { id: string; deviceId: number; projectId: number; invocation?: number; capability: string; method: string; args: unknown },
  now = Date.now(),
): CommandRecord {
  db.prepare('DELETE FROM device_commands WHERE created_at <= ?').run(iso(now - COMMAND_RETENTION_MS))
  db.prepare(
    `INSERT INTO device_commands (id, device_id, project_id, invocation, capability, method, args, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    command.id,
    command.deviceId,
    command.projectId,
    command.invocation ?? null,
    command.capability,
    command.method,
    JSON.stringify(command.args ?? {}),
    iso(now),
    iso(now + COMMAND_TTL_MS),
  )
  return getCommand(db, command.id)!
}

export function getCommand(db: DatabaseSync, id: string): CommandRecord | undefined {
  const row = db.prepare(`${SELECT_COMMAND} WHERE c.id = ?`).get(id)
  return row ? toCommand(row) : undefined
}

// Pending commands whose time ran out become expired.
export function expireCommands(db: DatabaseSync, now = Date.now()): CommandRecord[] {
  return db
    .prepare(
      `UPDATE device_commands SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?
       RETURNING *, (SELECT name FROM projects WHERE id = project_id) AS project`,
    )
    .all(iso(now))
    .map(toCommand)
}

// Oldest first, for resending after a hello.
export function pendingCommands(db: DatabaseSync, deviceId: number, now = Date.now()): CommandRecord[] {
  return db
    .prepare(`${SELECT_COMMAND} WHERE c.device_id = ? AND c.status = 'pending' AND c.expires_at > ? ORDER BY c.created_at, c.rowid`)
    .all(deviceId, iso(now))
    .map(toCommand)
}

// Records the device's answer. False when the command already has one: the
// same command can reach the app by socket, push and hello, and the first
// result wins. The app may still have run a command the host marked expired,
// so that answer is taken too.
export function answerCommand(
  db: DatabaseSync,
  id: string,
  outcome: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
  now = Date.now(),
): boolean {
  const result = db
    .prepare(
      `UPDATE device_commands SET status = ?, result = ?, answered_at = ?
       WHERE id = ? AND status IN ('pending', 'expired') AND answered_at IS NULL`,
    )
    .run(
      outcome.ok ? 'done' : 'failed',
      JSON.stringify(outcome.ok ? (outcome.value ?? null) : outcome.error),
      iso(now),
      id,
    )
  return Number(result.changes) > 0
}

export const NFC_TAG_ID = /^[A-Za-z0-9_-]{22}$/

export function newNfcTagId(): string {
  return randomBytes(16).toString('base64url')
}

export function recordNfcTag(db: DatabaseSync, id: string, projectId: number, now = Date.now()) {
  db.prepare('INSERT INTO nfc_tags (id, project_id, created_at) VALUES (?, ?, ?)').run(id, projectId, iso(now))
}

export function deleteNfcTag(db: DatabaseSync, id: string) {
  db.prepare('DELETE FROM nfc_tags WHERE id = ?').run(id)
}

// The project that wrote the tag.
export function nfcTagProject(db: DatabaseSync, id: string): string | undefined {
  if (!NFC_TAG_ID.test(id)) return undefined
  const row = db.prepare('SELECT p.name FROM nfc_tags t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(id)
  return row ? String(row.name) : undefined
}
