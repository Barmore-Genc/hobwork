import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

export type SecretInfo = {
  id: number
  name: string
  hosts: string[]
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
  assignments: AssignmentInfo[]
}

// A secret as one project sees it.
export type ProjectSecretInfo = {
  envName: string
  secretId: number
  secret: string
  hosts: string[]
  updatedAt: string
  assignedAt: string
  assignedBy: ActorInfo
}

export type NewSecret = {
  name: string
  value: string
  hosts: string[]
  // Assigns the new secret to a project in the same step.
  assign?: { project: string; envName: string }
}

export type SecretChange = { name?: string; value?: string; hosts?: string[] }

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

export function normalizeHosts(hosts: string[]): string[] {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new SecretError('Bind the secret to at least one host, like api.example.com')
  }
  if (hosts.length > MAX_HOSTS) throw new SecretError(`A secret can be bound to at most ${MAX_HOSTS} hosts`)
  const normalized = hosts.map((host) => String(host).trim().toLowerCase().replace(/\.$/, ''))
  for (const host of normalized) {
    if (host.length > 253 || !HOST_PATTERN.test(host) || host === INTERNAL_HOST) {
      throw new SecretError(`"${host}" is not a host name. Use a name like api.example.com, or *.example.com for its subdomains`)
    }
  }
  return [...new Set(normalized)]
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
  legacyAad: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
}

type AssignmentRow = AssignmentInfo & { secretId: number }

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toRow(row: Record<string, unknown>): Row {
  return {
    id: Number(row.id),
    name: String(row.name),
    value: row.value as Uint8Array,
    hosts: JSON.parse(String(row.hosts)) as string[],
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
  }
}

const SELECT = `SELECT s.id, s.name, s.value, s.hosts, s.legacy_aad, s.created_at, s.updated_at,
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

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

function actorLabel(actor: Actor): string {
  if (actor.kind === 'user') return actor.name
  if (actor.kind === 'agent') return `Agent ${actor.name}`
  return 'Someone on the Hobwork host'
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

  // What a project's VMs get.
  function assigned(project: string): { assignment: AssignmentRow; row: Row }[] {
    const projectId = requireProject(host, project).id
    return host.db
      .prepare(`${SELECT_ASSIGNMENT} WHERE a.project_id = ? ORDER BY a.env_name`)
      .all(projectId)
      .map(toAssignment)
      .map((assignment) => ({ assignment, row: requireSecret(assignment.secretId) }))
  }

  function info(row: Row): SecretInfo {
    return {
      id: row.id,
      name: row.name,
      hosts: row.hosts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      assignments: assignmentsOf(row.id).map(({ project, envName, assignedAt, assignedBy }) => ({ project, envName, assignedAt, assignedBy })),
    }
  }

  function projectInfo({ assignment, row }: { assignment: AssignmentRow; row: Row }): ProjectSecretInfo {
    return {
      envName: assignment.envName,
      secretId: row.id,
      secret: row.name,
      hosts: row.hosts,
      updatedAt: row.updatedAt,
      assignedAt: assignment.assignedAt,
      assignedBy: assignment.assignedBy,
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
          ? `"${row.name}" is already assigned to this project as ${envName}`
          : `This project already has ${envName} (the secret "${other.name}"). Unassign it first or pick another env name`,
      )
    }
    const existing = host.db
      .prepare('SELECT env_name FROM secret_assignments WHERE project_id = ? AND secret_id = ?')
      .get(projectId, row.id)
    if (existing) throw new SecretConflictError(`"${row.name}" is already assigned to this project as ${String(existing.env_name)}`)
    host.db
      .prepare(
        `INSERT INTO secret_assignments (project_id, secret_id, env_name, assigned_by_user_id, assigned_by_agent_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, row.id, envName, userId(actor), actor.kind === 'agent' ? actor.id : null)
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
      const hosts = normalizeHosts(input.hosts)
      const target = input.assign && { ...input.assign, projectId: requireProject(host, input.assign.project).id }
      if (target) validateEnvName(target.envName)
      if (nameTaken(name)) throw new SecretConflictError(`A secret called "${name}" already exists. Pick another name`)
      const id = transaction(() => {
        const inserted = host.db
          .prepare(
            `INSERT INTO secrets (name, value, hosts, created_by_user_id, updated_by_user_id)
             VALUES (?, x'', ?, ?, ?) RETURNING id`,
          )
          .get(name, JSON.stringify(hosts), userId(actor), userId(actor))
        if (!inserted) throw new Error('Secret insert returned no row')
        const newId = Number(inserted.id)
        host.db.prepare('UPDATE secrets SET value = ? WHERE id = ?').run(encrypt(newId, input.value), newId)
        if (target) insertAssignment(target.projectId, requireSecret(newId), target.envName, actor)
        return newId
      })
      if (target) {
        appendLogs(host, [
          logEntry(
            target.project,
            `${actorLabel(actor)} added the secret "${name}" as ${target.envName}. It is only sent to ${hosts.join(', ')}`,
          ),
        ])
      }
      return info(requireSecret(id))
    },

    update(ref: SecretRef, change: SecretChange, actor: Actor): SecretInfo {
      requirePerson(actor)
      const row = requireSecret(ref)
      const name = change.name === undefined ? row.name : normalizeName(change.name)
      const hosts = change.hosts === undefined ? row.hosts : normalizeHosts(change.hosts)
      if (change.value !== undefined) validateValue(change.value)
      if (nameTaken(name, row.id)) throw new SecretConflictError(`A secret called "${name}" already exists`)
      const valueChanged = change.value !== undefined
      const hostsChanged = hosts.join('\n') !== row.hosts.join('\n')
      if (!valueChanged && !hostsChanged && name === row.name) return info(row)
      host.db
        .prepare(
          `UPDATE secrets SET name = ?, value = ?, hosts = ?, legacy_aad = ?, updated_by_user_id = ?, updated_at = ${NOW}
           WHERE id = ?`,
        )
        .run(
          name,
          change.value === undefined ? row.value : encrypt(row.id, change.value),
          JSON.stringify(hosts),
          valueChanged ? null : row.legacyAad,
          userId(actor),
          row.id,
        )
      if (valueChanged || hostsChanged) {
        const what = [valueChanged && 'new value', hostsChanged && `now only sent to ${hosts.join(', ')}`]
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
    },

    // Also takes the secret away from every project it is assigned to.
    remove(ref: SecretRef, actor: Actor): boolean {
      requirePerson(actor)
      const row = find(ref)
      if (!row) return false
      const assignments = assignmentsOf(row.id)
      host.db.prepare('DELETE FROM secrets WHERE id = ?').run(row.id)
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
      appendLogs(host, [
        logEntry(
          project,
          `${actorLabel(actor)} added the secret "${row.name}" as ${envName}. It is only sent to ${row.hosts.join(', ')}`,
        ),
      ])
      return projectInfo(assigned(project).find(({ assignment }) => assignment.envName === envName)!)
    },

    unassign(project: string, envName: string, actor: Actor): boolean {
      const projectId = requireProject(host, project).id
      const removed = host.db
        .prepare('DELETE FROM secret_assignments WHERE project_id = ? AND env_name = ? RETURNING secret_id')
        .get(projectId, envName)
      if (!removed) return false
      const secret = find(Number(removed.secret_id))
      appendLogs(host, [logEntry(project, `${actorLabel(actor)} removed the secret "${secret?.name}" (${envName})`)])
      return true
    },

    // Values for the sandbox. Never hand these to anything that shows or
    // returns them.
    forSandbox(project: string): Record<string, Secret> {
      return Object.fromEntries(
        assigned(project).map(({ assignment, row }) => [assignment.envName, { value: decrypt(row), hosts: row.hosts }]),
      )
    },

    hosts(project: string): string[] {
      return [...new Set(assigned(project).flatMap(({ row }) => row.hosts))].sort()
    },

    // Changes whenever forSandbox would return something else.
    fingerprint(project: string): string {
      const hash = createHash('sha256')
      for (const { assignment, row } of assigned(project)) {
        hash.update(`${row.id}\0${assignment.envName}\0${row.hosts.join(',')}\0${row.updatedAt}\n`)
      }
      return hash.digest('hex')
    },
  }
}

export type SecretStore = ReturnType<typeof createSecretStore>
