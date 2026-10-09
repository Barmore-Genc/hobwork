import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishChange } from './changes.ts'
import type { Host } from './host.ts'
import { ProjectError, requireProject } from './projects.ts'
import { appendLogs, type NewLogEntry } from './runtime/logs.ts'
import { INTERNAL_HOST, type Secret } from './sandbox/sandbox.ts'

export const SECRET_KEY_FILE = 'secret.key'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
export const MAX_ENV_NAME_LENGTH = 64
const MAX_LABEL_LENGTH = 80
const MAX_VALUE_BYTES = 64 * 1024
const MAX_HOSTS = 20
const MAX_HEADERS = 10

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const HOST_LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
const HOST_PATTERN = new RegExp(`^(\\*\\.)?(${HOST_LABEL}\\.)*${HOST_LABEL}$`)
// Secrets become env vars in the guest, so they must not replace ones the
// guest or Hobwork rely on.
const RESERVED_NAMES = new Set([
  'CI',
  'HOME',
  'HOSTNAME',
  'LANG',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PWD',
  'SHELL',
  'TERM',
  'TZ',
  'USER',
])
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/
// Headers the HTTP client sets for the connection, or that name the destination.
const RESERVED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer', 'content-length'])
const RESERVED_PREFIXES = ['HOBWORK_', 'GONDOLIN_', 'NPM_CONFIG_']

export class SecretError extends ProjectError {}
export class SecretConflictError extends SecretError {}
export class SecretNotFoundError extends SecretError {}

// HOBWORK_SECRET_KEY (64 hex characters or base64 of 32 bytes) wins. Without
// it the key is <dataDir>/secret.key, created on first start and readable only
// by the host user. The env var keeps the key out of backups of the data dir.
export function loadSecretKey(dataDir: string, envKey?: string): Buffer {
  if (envKey) {
    const trimmed = envKey.trim()
    const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error('HOBWORK_SECRET_KEY must be 32 bytes as 64 hex characters or base64 (openssl rand -hex 32)')
    }
    return key
  }
  const path = join(dataDir, SECRET_KEY_FILE)
  if (!existsSync(path)) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path, `${randomBytes(KEY_BYTES).toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
  }
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users. Run: chmod 600 ${path}`)
  }
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex')
  if (key.length !== KEY_BYTES) throw new Error(`${path} must hold 64 hex characters`)
  return key
}

// Who made a change. `host` is someone running the secret command on the host.
export type Actor = { kind: 'user' | 'agent'; id: number; name: string } | { kind: 'host' }

export type ActorInfo = { kind: 'user' | 'agent'; name: string } | null

export type AssignmentInfo = {
  project: string
  envName: string
  assignedAt: string
  // Null when assigned on the host or carried over from before assignments existed.
  assignedBy: ActorInfo
}

// A secret every hob gets under an env name, unless it has its own secret under that name.
export type AllHobsInfo = {
  envName: string
  assignedAt: string
  assignedBy: ActorInfo
}

export type SecretInfo = {
  id: number
  name: string
  hosts: string[]
  // Names of the headers, besides Authorization, that the value is filled into.
  headers: string[]
  // The newest host request that waits for an answer.
  pendingHostRequest: { id: number; hosts: string[]; agent: string | null } | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
  assignments: AssignmentInfo[]
  allHobs: AllHobsInfo | null
}

// A secret as one project sees it.
export type ProjectSecretInfo = {
  envName: string
  secretId: number
  secret: string
  hosts: string[]
  headers: string[]
  updatedAt: string
  assignedAt: string
  assignedBy: ActorInfo
  // Given to every hob, so it cannot be removed from one.
  allHobs: boolean
}

export type HostRequestDecision = 'approved' | 'denied' | 'superseded'

export type HostRequest = {
  id: number
  secret: { id: number; name: string; hosts: string[] }
  agent: string | null
  hosts: string[]
  reason: string
  createdAt: string
  decision: HostRequestDecision | null
  decidedAt: string | null
  decidedBy: string | null
}

export const MAX_HOST_REQUEST_REASON = 500

export type NewSecret = {
  name: string
  value: string
  hosts?: string[]
  // Besides Authorization, which always works.
  headers?: string[]
  // Assigns the new secret to a project in the same step.
  assign?: { project: string; envName: string }
}

export type SecretChange = { name?: string; value?: string; hosts?: string[]; headers?: string[] }

// A secret's ID or its name.
export type SecretRef = number | string

export function validateEnvName(name: string): void {
  if (typeof name !== 'string' || !ENV_NAME.test(name) || name.length > MAX_ENV_NAME_LENGTH) {
    throw new SecretError(
      `Env names use capital letters, digits and underscores, like OPENROUTER_API_KEY (at most ${MAX_ENV_NAME_LENGTH} characters)`,
    )
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new SecretError(`${name} is reserved. Choose another env name`)
  }
}

function normalizeName(name: unknown): string {
  const label = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  if (!label) throw new SecretError('Give the secret a name, like "Spoolman API key"')
  if (label.length > MAX_LABEL_LENGTH) throw new SecretError(`Secret names are at most ${MAX_LABEL_LENGTH} characters`)
  if (/\p{Cc}/u.test(label)) throw new SecretError('Secret names must not contain control characters')
  return label
}

// A secret without hosts is never sent anywhere. Agents ask for hosts with a
// host request, which a person approves.
export function normalizeHosts(hosts: string[]): string[] {
  if (!Array.isArray(hosts)) throw new SecretError('Hosts must be a list of host names, like api.example.com')
  if (hosts.length > MAX_HOSTS) throw new SecretError(`A secret can be bound to at most ${MAX_HOSTS} hosts`)
  const normalized = hosts.map((host) => String(host).trim().toLowerCase().replace(/\.$/, ''))
  for (const host of normalized) {
    if (host.length > 253 || !HOST_PATTERN.test(host) || host === INTERNAL_HOST) {
      throw new SecretError(`"${host}" is not a host name. Use a name like api.example.com, or *.example.com for its subdomains`)
    }
  }
  return [...new Set(normalized)]
}

// Names of headers besides Authorization that a secret may be filled into.
export function normalizeHeaders(headers: string[]): string[] {
  if (!Array.isArray(headers)) throw new SecretError('Headers must be a list of header names, like X-Api-Key')
  const normalized = headers.map((header) => String(header).trim().toLowerCase())
  for (const header of normalized) {
    if (header.length > 100 || !HEADER_NAME.test(header) || RESERVED_HEADERS.has(header)) {
      throw new SecretError(`"${header}" is not a header a secret can be sent in. Use a name like X-Api-Key`)
    }
  }
  const unique = [...new Set(normalized)].filter((header) => header !== 'authorization')
  if (unique.length > MAX_HEADERS) throw new SecretError(`A secret can be sent in at most ${MAX_HEADERS} headers besides Authorization`)
  return unique
}

function validateValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new SecretError('The secret value must not be empty')
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new SecretError('The secret value is larger than 64 KB')
  if (/[\r\n\0]/.test(value)) throw new SecretError('The secret value must be a single line, since it is sent in HTTP headers')
}

type Row = {
  id: number
  name: string
  value: Uint8Array
  hosts: string[]
  headers: string[]
  legacyAad: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
}

type AssignmentRow = AssignmentInfo & { secretId: number; allHobs: boolean }

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toRow(row: Record<string, unknown>): Row {
  return {
    id: Number(row.id),
    name: String(row.name),
    value: row.value as Uint8Array,
    hosts: JSON.parse(String(row.hosts)) as string[],
    headers: JSON.parse(String(row.headers)) as string[],
    legacyAad: nullableString(row.legacy_aad),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    createdBy: nullableString(row.created_by),
    updatedBy: nullableString(row.updated_by),
  }
}

function toAssignment(row: Record<string, unknown>): AssignmentRow {
  const user = nullableString(row.user_name)
  const agent = nullableString(row.agent_name)
  return {
    secretId: Number(row.secret_id),
    project: String(row.project),
    envName: String(row.env_name),
    assignedAt: String(row.assigned_at),
    assignedBy: user !== null ? { kind: 'user', name: user } : agent !== null ? { kind: 'agent', name: agent } : null,
    allHobs: false,
  }
}

function toAllHobs(row: Record<string, unknown>): AllHobsInfo & { secretId: number } {
  const user = nullableString(row.user_name)
  return {
    secretId: Number(row.secret_id),
    envName: String(row.env_name),
    assignedAt: String(row.assigned_at),
    assignedBy: user === null ? null : { kind: 'user', name: user },
  }
}

const SELECT = `SELECT s.id, s.name, s.value, s.hosts, s.headers, s.legacy_aad, s.created_at, s.updated_at,
    cu.name AS created_by, uu.name AS updated_by
  FROM secrets s
  LEFT JOIN users cu ON cu.id = s.created_by_user_id
  LEFT JOIN users uu ON uu.id = s.updated_by_user_id`

const SELECT_ASSIGNMENT = `SELECT a.secret_id, p.name AS project, a.env_name, a.assigned_at,
    u.name AS user_name, g.name AS agent_name
  FROM secret_assignments a
  JOIN projects p ON p.id = a.project_id
  LEFT JOIN users u ON u.id = a.assigned_by_user_id
  LEFT JOIN agents g ON g.id = a.assigned_by_agent_id`

const SELECT_ALL_HOBS = `SELECT a.secret_id, a.env_name, a.assigned_at, u.name AS user_name
  FROM all_hobs_secrets a
  LEFT JOIN users u ON u.id = a.assigned_by_user_id`

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

function actorLabel(actor: Actor): string {
  if (actor.kind === 'user') return actor.name
  if (actor.kind === 'agent') return `Agent ${actor.name}`
  return 'Someone on the Hobwork host'
}

function headerList(headers: string[]): string {
  return headers.length ? `the Authorization header and ${headers.join(', ')}` : 'the Authorization header only'
}

function sentTo(hosts: string[], headers: string[]): string {
  return hosts.length
    ? `It is only sent to ${hosts.join(', ')}${headers.length ? `, in ${headerList(headers)}` : ''}`
    : 'It is not sent anywhere until it has hosts'
}

function logEntry(project: string, message: string): NewLogEntry {
  return { project, source: 'runtime', level: 'info', event: 'secret', message }
}

export function createSecretStore(host: Host, key: Buffer) {
  if (key.length !== KEY_BYTES) throw new Error('The secret key must be 32 bytes')

  // Binds each ciphertext to its secret, so a value copied into another row
  // does not decrypt. The name is left out so a secret can be renamed.
  function aad(id: number): Buffer {
    return Buffer.from(`hobwork-secret:v2:${id}`)
  }

  function encrypt(id: number, value: string): Buffer {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad(id))
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }

  function decrypt(row: Row): string {
    const data = Buffer.from(row.value)
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES)).setAAD(
      row.legacyAad === null ? aad(row.id) : Buffer.from(row.legacyAad),
    )
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    try {
      return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
    } catch {
      throw new Error(`Secret "${row.name}" cannot be decrypted. Was the secret key changed?`)
    }
  }

  // Values carried over from project and global secrets (migration 0010) are
  // still encrypted with their old additional data. Ones that do not decrypt
  // (a changed key) stay as they are and fail when a VM needs them, as before.
  function reencryptLegacy(): void {
    const legacy = host.db.prepare(`${SELECT} WHERE s.legacy_aad IS NOT NULL`).all().map(toRow)
    const update = host.db.prepare('UPDATE secrets SET value = ?, legacy_aad = NULL WHERE id = ?')
    for (const row of legacy) {
      let value: string
      try {
        value = decrypt(row)
      } catch {
        continue
      }
      update.run(encrypt(row.id, value), row.id)
    }
  }

  function transaction<T>(fn: () => T): T {
    host.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      host.db.exec('COMMIT')
      return result
    } catch (err) {
      host.db.exec('ROLLBACK')
      throw err
    }
  }

  function find(ref: SecretRef): Row | undefined {
    const row =
      typeof ref === 'number'
        ? host.db.prepare(`${SELECT} WHERE s.id = ?`).get(ref)
        : host.db.prepare(`${SELECT} WHERE s.name = ?`).get(String(ref).trim())
    return row ? toRow(row) : undefined
  }

  function requireSecret(ref: SecretRef): Row {
    const row = find(ref)
    if (!row) throw new SecretNotFoundError(typeof ref === 'number' ? 'This secret no longer exists' : `There is no secret called "${ref}"`)
    return row
  }

  function nameTaken(name: string, exceptId?: number): boolean {
    const row = host.db.prepare('SELECT id FROM secrets WHERE name = ?').get(name)
    return row !== undefined && Number(row.id) !== exceptId
  }

  function assignmentsOf(secretId: number): AssignmentRow[] {
    return host.db
      .prepare(`${SELECT_ASSIGNMENT} WHERE a.secret_id = ? ORDER BY p.name, a.env_name`)
      .all(secretId)
      .map(toAssignment)
  }

  function allHobsOf(where: string, ...params: (string | number)[]) {
    const row = host.db.prepare(`${SELECT_ALL_HOBS} WHERE ${where}`).get(...params)
    return row && toAllHobs(row)
  }

  // What a project's VMs get: its own secrets, and the ones for all hobs under
  // env names it has no secret for.
  function assigned(project: string): { assignment: AssignmentRow; row: Row }[] {
    const projectId = requireProject(host, project).id
    const own = host.db.prepare(`${SELECT_ASSIGNMENT} WHERE a.project_id = ?`).all(projectId).map(toAssignment)
    const names = new Set(own.map((assignment) => assignment.envName))
    const shared = host.db
      .prepare(SELECT_ALL_HOBS)
      .all()
      .map(toAllHobs)
      .filter(({ envName }) => !names.has(envName))
      .map((row): AssignmentRow => ({ ...row, project, allHobs: true }))
    return [...own, ...shared]
      .sort((a, b) => (a.envName < b.envName ? -1 : a.envName > b.envName ? 1 : 0))
      .map((assignment) => ({ assignment, row: requireSecret(assignment.secretId) }))
  }

  function pendingHostRequest(secretId: number): SecretInfo['pendingHostRequest'] {
    const row = host.db
      .prepare(
        `SELECT r.id, r.hosts, a.name AS agent FROM secret_host_requests r LEFT JOIN agents a ON a.id = r.agent_id
         WHERE r.secret_id = ? AND r.decision IS NULL ORDER BY r.id DESC LIMIT 1`,
      )
      .get(secretId)
    return row ? { id: Number(row.id), hosts: JSON.parse(String(row.hosts)) as string[], agent: nullableString(row.agent) } : null
  }

  function hostRequest(id: number): HostRequest | undefined {
    const row = host.db
      .prepare(
        `SELECT r.id, r.secret_id, a.name AS agent, r.hosts, r.reason, r.created_at, r.decision, r.decided_at, u.name AS decided_by
         FROM secret_host_requests r
         LEFT JOIN agents a ON a.id = r.agent_id
         LEFT JOIN users u ON u.id = r.decided_by_user_id
         WHERE r.id = ?`,
      )
      .get(id)
    if (!row) return undefined
    const secret = requireSecret(Number(row.secret_id))
    return {
      id: Number(row.id),
      secret: { id: secret.id, name: secret.name, hosts: secret.hosts },
      agent: nullableString(row.agent),
      hosts: JSON.parse(String(row.hosts)) as string[],
      reason: String(row.reason),
      createdAt: String(row.created_at),
      decision: nullableString(row.decision) as HostRequestDecision | null,
      decidedAt: nullableString(row.decided_at),
      decidedBy: nullableString(row.decided_by),
    }
  }

  function allHobsInfo(secretId: number): AllHobsInfo | null {
    const shared = allHobsOf('a.secret_id = ?', secretId)
    return shared ? { envName: shared.envName, assignedAt: shared.assignedAt, assignedBy: shared.assignedBy } : null
  }

  function info(row: Row): SecretInfo {
    return {
      id: row.id,
      name: row.name,
      hosts: row.hosts,
      headers: row.headers,
      pendingHostRequest: pendingHostRequest(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      assignments: assignmentsOf(row.id).map(({ project, envName, assignedAt, assignedBy }) => ({ project, envName, assignedAt, assignedBy })),
      allHobs: allHobsInfo(row.id),
    }
  }

  function projectInfo({ assignment, row }: { assignment: AssignmentRow; row: Row }): ProjectSecretInfo {
    return {
      envName: assignment.envName,
      secretId: row.id,
      secret: row.name,
      hosts: row.hosts,
      headers: row.headers,
      updatedAt: row.updatedAt,
      assignedAt: assignment.assignedAt,
      assignedBy: assignment.assignedBy,
      allHobs: assignment.allHobs,
    }
  }

  function userId(actor: Actor): number | null {
    return actor.kind === 'user' ? actor.id : null
  }

  // Values and hosts are only ever set by people. An agent that could set
  // hosts could send any assigned value anywhere.
  function requirePerson(actor: Actor): void {
    if (actor.kind === 'agent') throw new SecretError('Only people can create, change or delete secrets, in Hobwork')
  }

  function insertAssignment(projectId: number, row: Row, envName: string, actor: Actor): void {
    validateEnvName(envName)
    const clash = host.db
      .prepare('SELECT secret_id FROM secret_assignments WHERE project_id = ? AND env_name = ?')
      .get(projectId, envName)
    if (clash) {
      const other = requireSecret(Number(clash.secret_id))
      throw new SecretConflictError(
        other.id === row.id
          ? `"${row.name}" is already assigned to this hob as ${envName}`
          : `This hob already has ${envName} (the secret "${other.name}"). Unassign it first or pick another env name`,
      )
    }
    const existing = host.db
      .prepare('SELECT env_name FROM secret_assignments WHERE project_id = ? AND secret_id = ?')
      .get(projectId, row.id)
    if (existing) throw new SecretConflictError(`"${row.name}" is already assigned to this hob as ${String(existing.env_name)}`)
    host.db
      .prepare(
        `INSERT INTO secret_assignments (project_id, secret_id, env_name, assigned_by_user_id, assigned_by_agent_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, row.id, envName, userId(actor), actor.kind === 'agent' ? actor.id : null)
  }

  function insertSecret(name: string, value: string, hosts: string[], headers: string[], actor: Actor): number {
    const inserted = host.db
      .prepare(
        `INSERT INTO secrets (name, value, hosts, headers, created_by_user_id, updated_by_user_id)
         VALUES (?, x'', ?, ?, ?, ?) RETURNING id`,
      )
      .get(name, JSON.stringify(hosts), JSON.stringify(headers), userId(actor), userId(actor))
    if (!inserted) throw new Error('Secret insert returned no row')
    const id = Number(inserted.id)
    host.db.prepare('UPDATE secrets SET value = ? WHERE id = ?').run(encrypt(id, value), id)
    return id
  }

  function changed(): void {
    publishChange(host.db, { kind: 'secrets' })
  }

  function update(row: Row, change: SecretChange, actor: Actor): SecretInfo {
    const name = change.name === undefined ? row.name : normalizeName(change.name)
    const hosts = change.hosts === undefined ? row.hosts : normalizeHosts(change.hosts)
    const headers = change.headers === undefined ? row.headers : normalizeHeaders(change.headers)
    if (change.value !== undefined) validateValue(change.value)
    if (nameTaken(name, row.id)) throw new SecretConflictError(`A secret called "${name}" already exists`)
    const valueChanged = change.value !== undefined
    const hostsChanged = hosts.join('\n') !== row.hosts.join('\n')
    const headersChanged = headers.join('\n') !== row.headers.join('\n')
    if (!valueChanged && !hostsChanged && !headersChanged && name === row.name) return info(row)
    host.db
      .prepare(
        `UPDATE secrets SET name = ?, value = ?, hosts = ?, headers = ?, legacy_aad = ?, updated_by_user_id = ?, updated_at = ${NOW}
         WHERE id = ?`,
      )
      .run(
        name,
        change.value === undefined ? row.value : encrypt(row.id, change.value),
        JSON.stringify(hosts),
        JSON.stringify(headers),
        valueChanged ? null : row.legacyAad,
        userId(actor),
        row.id,
      )
    changed()
    if (valueChanged || hostsChanged || headersChanged) {
      const what = [
        valueChanged && 'new value',
        hostsChanged && (hosts.length ? `now only sent to ${hosts.join(', ')}` : 'no longer sent anywhere'),
        headersChanged && `now sent in ${headerList(headers)}`,
      ]
        .filter(Boolean)
        .join(', ')
      appendLogs(
        host,
        assignmentsOf(row.id).map(({ project, envName }) =>
          logEntry(project, `${actorLabel(actor)} changed the secret "${name}" (${envName}): ${what}`),
        ),
      )
    }
    return info(requireSecret(row.id))
  }

  reencryptLegacy()

  return {
    // The whole library, or only the secrets assigned to one project.
    list(project?: string): SecretInfo[] {
      if (project === undefined) return host.db.prepare(`${SELECT} ORDER BY s.name`).all().map(toRow).map(info)
      const projectId = requireProject(host, project).id
      return host.db
        .prepare(`${SELECT} WHERE s.id IN (SELECT secret_id FROM secret_assignments WHERE project_id = ?) ORDER BY s.name`)
        .all(projectId)
        .map(toRow)
        .map(info)
    },

    get(ref: SecretRef): SecretInfo | undefined {
      const row = find(ref)
      return row && info(row)
    },

    // The secrets a project's handlers can use, by env name.
    assigned(project: string): ProjectSecretInfo[] {
      return assigned(project).map(projectInfo)
    },

    create(input: NewSecret, actor: Actor): SecretInfo {
      requirePerson(actor)
      const name = normalizeName(input.name)
      validateValue(input.value)
      const hosts = normalizeHosts(input.hosts ?? [])
      const headers = normalizeHeaders(input.headers ?? [])
      const target = input.assign && { ...input.assign, projectId: requireProject(host, input.assign.project).id }
      if (target) validateEnvName(target.envName)
      if (nameTaken(name)) throw new SecretConflictError(`A secret called "${name}" already exists. Pick another name`)
      const id = transaction(() => {
        const newId = insertSecret(name, input.value, hosts, headers, actor)
        if (target) insertAssignment(target.projectId, requireSecret(newId), target.envName, actor)
        return newId
      })
      changed()
      if (target) {
        appendLogs(host, [
          logEntry(
            target.project,
            `${actorLabel(actor)} added the secret "${name}" as ${target.envName}. ${sentTo(hosts, headers)}`,
          ),
        ])
      }
      return info(requireSecret(id))
    },

    update(ref: SecretRef, change: SecretChange, actor: Actor): SecretInfo {
      requirePerson(actor)
      return update(requireSecret(ref), change, actor)
    },

    // An agent asks for the hosts a secret may be sent to. They replace the
    // current hosts once a person approves the request.
    requestHosts(ref: SecretRef, hosts: string[], reason: string, actor: Actor & { kind: 'agent' }): HostRequest {
      const row = requireSecret(ref)
      const normalized = normalizeHosts(hosts)
      if (normalized.length === 0) throw new SecretError('Ask for at least one host, like api.example.com')
      const why = reason.trim()
      if (!why) throw new SecretError('Say why the secret needs these hosts, so the user can decide')
      if (why.length > MAX_HOST_REQUEST_REASON) throw new SecretError(`Keep the reason under ${MAX_HOST_REQUEST_REASON} characters`)
      const id = transaction(() => {
        host.db
          .prepare(
            `UPDATE secret_host_requests SET decision = 'superseded', decided_at = ${NOW}
             WHERE secret_id = ? AND decision IS NULL`,
          )
          .run(row.id)
        const inserted = host.db
          .prepare('INSERT INTO secret_host_requests (secret_id, agent_id, hosts, reason) VALUES (?, ?, ?, ?) RETURNING id')
          .get(row.id, actor.id, JSON.stringify(normalized), why)
        if (!inserted) throw new Error('Host request insert returned no row')
        return Number(inserted.id)
      })
      changed()
      return hostRequest(id)!
    },

    hostRequest(id: number): HostRequest | undefined {
      return hostRequest(id)
    },

    decideHostRequest(id: number, approve: boolean, actor: Actor): HostRequest {
      requirePerson(actor)
      const request = hostRequest(id)
      if (!request) throw new SecretNotFoundError('This request no longer exists')
      if (request.decision !== null) throw new SecretConflictError(`This request was already ${request.decision}`)
      if (approve) update(requireSecret(request.secret.id), { hosts: request.hosts }, actor)
      host.db
        .prepare(`UPDATE secret_host_requests SET decision = ?, decided_at = ${NOW}, decided_by_user_id = ? WHERE id = ?`)
        .run(approve ? 'approved' : 'denied', userId(actor), id)
      changed()
      return hostRequest(id)!
    },

    // Also takes the secret away from every project it is assigned to.
    remove(ref: SecretRef, actor: Actor): boolean {
      requirePerson(actor)
      const row = find(ref)
      if (!row) return false
      const assignments = assignmentsOf(row.id)
      host.db.prepare('DELETE FROM secrets WHERE id = ?').run(row.id)
      changed()
      appendLogs(
        host,
        assignments.map(({ project, envName }) =>
          logEntry(project, `${actorLabel(actor)} deleted the secret "${row.name}", so ${envName} is gone`),
        ),
      )
      return true
    },

    assign(project: string, ref: SecretRef, envName: string, actor: Actor): ProjectSecretInfo {
      const projectId = requireProject(host, project).id
      const row = requireSecret(ref)
      insertAssignment(projectId, row, envName, actor)
      changed()
      appendLogs(host, [
        logEntry(
          project,
          `${actorLabel(actor)} added the secret "${row.name}" as ${envName}. ${sentTo(row.hosts, row.headers)}`,
        ),
      ])
      return projectInfo(assigned(project).find(({ assignment }) => assignment.envName === envName)!)
    },

    // The secret every hob without its own secret under envName gets.
    forAllHobs(envName: string): SecretInfo | undefined {
      const shared = allHobsOf('a.env_name = ?', envName)
      return shared && info(requireSecret(shared.secretId))
    },

    // Projects that have their own secret under envName instead of the one for all hobs.
    projectsWithOwn(envName: string): string[] {
      return host.db
        .prepare('SELECT p.name FROM secret_assignments a JOIN projects p ON p.id = a.project_id WHERE a.env_name = ? ORDER BY p.name')
        .all(envName)
        .map((row) => String(row.name))
    },

    // Changes the value of the secret for all hobs under envName, or creates
    // one called `name` (numbered when the name is taken) with these hosts.
    setForAllHobs(envName: string, input: { name: string; value: string; hosts: string[] }, actor: Actor): SecretInfo {
      requirePerson(actor)
      validateEnvName(envName)
      validateValue(input.value)
      const shared = allHobsOf('a.env_name = ?', envName)
      if (shared) return update(requireSecret(shared.secretId), { value: input.value }, actor)
      const hosts = normalizeHosts(input.hosts)
      const base = normalizeName(input.name)
      let name = base
      for (let n = 2; nameTaken(name); n++) name = `${base} ${n}`
      const id = transaction(() => {
        const newId = insertSecret(name, input.value, hosts, [], actor)
        host.db
          .prepare('INSERT INTO all_hobs_secrets (env_name, secret_id, assigned_by_user_id) VALUES (?, ?, ?)')
          .run(envName, newId, userId(actor))
        return newId
      })
      changed()
      return info(requireSecret(id))
    },

    // Also deletes the secret when no hob has it assigned.
    removeForAllHobs(envName: string, actor: Actor): boolean {
      requirePerson(actor)
      const shared = allHobsOf('a.env_name = ?', envName)
      if (!shared) return false
      transaction(() => {
        host.db.prepare('DELETE FROM all_hobs_secrets WHERE env_name = ?').run(envName)
        if (assignmentsOf(shared.secretId).length === 0) host.db.prepare('DELETE FROM secrets WHERE id = ?').run(shared.secretId)
      })
      changed()
      return true
    },

    unassign(project: string, envName: string, actor: Actor): boolean {
      const projectId = requireProject(host, project).id
      const removed = host.db
        .prepare('DELETE FROM secret_assignments WHERE project_id = ? AND env_name = ? RETURNING secret_id')
        .get(projectId, envName)
      if (!removed) return false
      changed()
      const secret = find(Number(removed.secret_id))
      appendLogs(host, [logEntry(project, `${actorLabel(actor)} removed the secret "${secret?.name}" (${envName})`)])
      return true
    },

    // Values for the sandbox. Never hand these to anything that shows or
    // returns them.
    forSandbox(project: string): Record<string, Secret> {
      return Object.fromEntries(
        assigned(project).map(({ assignment, row }) => [assignment.envName, { value: decrypt(row), hosts: row.hosts, headers: row.headers }]),
      )
    },

    hosts(project: string): string[] {
      return [...new Set(assigned(project).flatMap(({ row }) => row.hosts))].sort()
    },

    // Changes whenever forSandbox would return something else. Hashes the
    // ciphertext rather than updated_at, which two writes in the same
    // millisecond share; every write encrypts with a new IV.
    fingerprint(project: string): string {
      const hash = createHash('sha256')
      for (const { assignment, row } of assigned(project)) {
        hash.update(`${row.id}\0${assignment.envName}\0${row.hosts.join(',')}\0${row.headers.join(',')}\0`)
        hash.update(row.value)
        hash.update('\n')
      }
      return hash.digest('hex')
    },
  }
}

export type SecretStore = ReturnType<typeof createSecretStore>
