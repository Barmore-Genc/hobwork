import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Host } from './host.ts'
import { ProjectError, requireProject } from './projects.ts'
import { INTERNAL_HOST, type Secret } from './sandbox/sandbox.ts'

export const SECRET_KEY_FILE = 'secret.key'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_NAME_LENGTH = 64
const MAX_VALUE_BYTES = 64 * 1024
const MAX_HOSTS = 20

const NAME = /^[A-Z_][A-Z0-9_]*$/
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

export type SecretScope = 'project' | 'global'

export type SecretInfo = {
  name: string
  scope: SecretScope
  hosts: string[]
  createdAt: string
  updatedAt: string
}

export type SecretInput = {
  // Undefined for a global secret.
  project?: string
  name: string
  // Required when creating. Leaving it out on an update keeps the value.
  value?: string
  hosts?: string[]
}

export function validateSecretName(name: string): void {
  if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new SecretError(
      `Secret names use capital letters, digits and underscores, like OPENROUTER_API_KEY (at most ${MAX_NAME_LENGTH} characters)`,
    )
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new SecretError(`${name} is reserved. Choose another name`)
  }
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

function validateValue(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new SecretError('The secret value must not be empty')
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new SecretError('The secret value is larger than 64 KB')
  if (/[\r\n\0]/.test(value)) throw new SecretError('The secret value must be a single line, since it is sent in HTTP headers')
}

type Row = { id: number; projectId: number | null; name: string; value: Uint8Array; hosts: string[]; createdAt: string; updatedAt: string }

function toRow(row: Record<string, unknown>): Row {
  return {
    id: Number(row.id),
    projectId: row.project_id === null ? null : Number(row.project_id),
    name: String(row.name),
    value: row.value as Uint8Array,
    hosts: JSON.parse(String(row.hosts)) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

const SELECT = 'SELECT id, project_id, name, value, hosts, created_at, updated_at FROM secrets'

export function createSecretStore(host: Host, key: Buffer) {
  if (key.length !== KEY_BYTES) throw new Error('The secret key must be 32 bytes')

  // Binds each ciphertext to its row, so a value copied into another project
  // or name does not decrypt.
  function aad(projectId: number | null, name: string): Buffer {
    return Buffer.from(`hobwork-secret:v1:${projectId ?? 'global'}:${name}`)
  }

  function encrypt(projectId: number | null, name: string, value: string): Buffer {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad(projectId, name))
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }

  function decrypt(row: Row): string {
    const data = Buffer.from(row.value)
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES)).setAAD(aad(row.projectId, row.name))
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    try {
      return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
    } catch {
      throw new Error(`Secret ${row.name} cannot be decrypted. Was the secret key changed?`)
    }
  }

  function projectId(project: string | undefined): number | null {
    return project === undefined ? null : requireProject(host, project).id
  }

  function rows(projectIdValue: number | null): Row[] {
    const all =
      projectIdValue === null
        ? host.db.prepare(`${SELECT} WHERE project_id IS NULL ORDER BY name`).all()
        : host.db.prepare(`${SELECT} WHERE project_id = ? ORDER BY name`).all(projectIdValue)
    return all.map(toRow)
  }

  function find(projectIdValue: number | null, name: string): Row | undefined {
    const row =
      projectIdValue === null
        ? host.db.prepare(`${SELECT} WHERE project_id IS NULL AND name = ?`).get(name)
        : host.db.prepare(`${SELECT} WHERE project_id = ? AND name = ?`).get(projectIdValue, name)
    return row ? toRow(row) : undefined
  }

  // What a project's VMs get: its own secrets, plus global ones it does not override.
  function effective(project: string): Row[] {
    const own = rows(requireProject(host, project).id)
    const names = new Set(own.map((row) => row.name))
    return [...own, ...rows(null).filter((row) => !names.has(row.name))].sort((a, b) => a.name.localeCompare(b.name))
  }

  function info(row: Row): SecretInfo {
    return {
      name: row.name,
      scope: row.projectId === null ? 'global' : 'project',
      hosts: row.hosts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  return {
    // Secrets of one scope: a project's own, or the global ones.
    list(project?: string): SecretInfo[] {
      return rows(projectId(project)).map(info)
    },

    // The secrets a project's handlers can use, global ones included.
    effective(project: string): SecretInfo[] {
      return effective(project).map(info)
    },

    set(input: SecretInput): { created: boolean } {
      validateSecretName(input.name)
      const id = projectId(input.project)
      const hosts = input.hosts === undefined ? undefined : normalizeHosts(input.hosts)
      if (input.value !== undefined) validateValue(input.value)
      const existing = find(id, input.name)
      if (!existing) {
        if (input.value === undefined || hosts === undefined) {
          throw new SecretError('A new secret needs a value and at least one host')
        }
        host.db
          .prepare('INSERT INTO secrets (project_id, name, value, hosts) VALUES (?, ?, ?, ?)')
          .run(id, input.name, encrypt(id, input.name, input.value), JSON.stringify(hosts))
        return { created: true }
      }
      host.db
        .prepare(
          `UPDATE secrets SET value = ?, hosts = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        )
        .run(
          input.value === undefined ? existing.value : encrypt(id, input.name, input.value),
          JSON.stringify(hosts ?? existing.hosts),
          existing.id,
        )
      return { created: false }
    },

    remove(project: string | undefined, name: string): boolean {
      const existing = find(projectId(project), name)
      if (!existing) return false
      host.db.prepare('DELETE FROM secrets WHERE id = ?').run(existing.id)
      return true
    },

    // Values for the sandbox. Never hand these to anything that shows or
    // returns them.
    forSandbox(project: string): Record<string, Secret> {
      return Object.fromEntries(effective(project).map((row) => [row.name, { value: decrypt(row), hosts: row.hosts }]))
    },

    hosts(project: string): string[] {
      return [...new Set(effective(project).flatMap((row) => row.hosts))].sort()
    },

    // Changes whenever forSandbox would return something else.
    fingerprint(project: string): string {
      const hash = createHash('sha256')
      for (const row of effective(project)) hash.update(`${row.id}\0${row.name}\0${row.hosts.join(',')}\0${row.updatedAt}\n`)
      return hash.digest('hex')
    },
  }
}

export type SecretStore = ReturnType<typeof createSecretStore>
