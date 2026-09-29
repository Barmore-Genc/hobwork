import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import ssh2, { type ParsedKey } from 'ssh2'
import { FULL_ACCESS, loadAccess } from '../access.ts'
import { getAgent, type AuthenticatedAgent, type Credential } from '../agents.ts'

// Where a key was added. null for keys added before this was recorded.
export type SshKeySource =
  | { via: 'web'; userName: string | null }
  | { via: 'agent'; token: { id: number; createdAt: string } | null; signIn: { id: number; clientName: string } | null }
  | { via: 'host' }

export type SshKey = {
  id: number
  agentId: number
  name: string
  algorithm: string
  fingerprint: string
  comment: string
  addedFrom: SshKeySource | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type AddedBy = { via: 'web'; userId: number } | { via: 'agent'; credential?: Credential } | { via: 'host' }

export class SshKeyError extends Error {}

const MAX_KEY_CHARS = 16 * 1024
export const MAX_SSH_KEY_NAME = 64

// Same format as `ssh-keygen -l`.
export function fingerprint(keyData: Buffer): string {
  return `SHA256:${createHash('sha256').update(keyData).digest('base64').replace(/=+$/, '')}`
}

// Not ssh2.utils.generateKeyPairSync: it strips leading zero bytes from the raw
// Ed25519 public key, so about 1 in 256 generated pairs are unparseable.
export function generateEd25519KeyPair(): { public: string; private: string } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const pub = Buffer.from(String(jwk.x), 'base64url')
  const seed = Buffer.from(String(jwk.d), 'base64url')
  const publicWire = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])
  const check = randomBytes(4)
  const unpadded = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(''),
  ])
  const padding = Buffer.from(Array.from({ length: (8 - (unpadded.length % 8)) % 8 }, (_, i) => i + 1))
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicWire),
    sshString(Buffer.concat([unpadded, padding])),
  ])
  const lines = body.toString('base64').match(/.{1,70}/g)?.join('\n')
  return {
    public: `ssh-ed25519 ${publicWire.toString('base64')}`,
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`,
  }
}

function sshString(value: string | Buffer): Buffer {
  const data = Buffer.from(value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, data])
}

export function parsePublicKey(line: string): { algorithm: string; keyData: string; comment: string } {
  const text = line.trim()
  if (!text) throw new SshKeyError('Paste a public key, e.g. the contents of ~/.ssh/id_ed25519.pub')
  if (text.length > MAX_KEY_CHARS) throw new SshKeyError('This is too long for a public key')
  const parsed = ssh2.utils.parseKey(text)
  if (parsed instanceof Error || Array.isArray(parsed)) {
    throw new SshKeyError('This is not an SSH public key. Paste one line like "ssh-ed25519 AAAA... name"')
  }
  if (parsed.isPrivateKey()) {
    throw new SshKeyError('This is a private key. Paste the public key instead (the .pub file) and keep the private key secret')
  }
  return {
    algorithm: parsed.type,
    keyData: parsed.getPublicSSH().toString('base64'),
    comment: parsed.comment.slice(0, 200),
  }
}

function nullable(value: unknown): string | null {
  return value === null ? null : String(value)
}

function source(row: Record<string, unknown>): SshKeySource | null {
  switch (row.added_via) {
    case 'web':
      return { via: 'web', userName: nullable(row.user_name) }
    case 'agent':
      return {
        via: 'agent',
        token: row.added_by_token_id === null ? null : { id: Number(row.added_by_token_id), createdAt: String(row.token_created_at) },
        signIn: row.added_by_grant_id === null ? null : { id: Number(row.added_by_grant_id), clientName: String(row.grant_client_name) },
      }
    case 'host':
      return { via: 'host' }
    default:
      return null
  }
}

function toKey(row: Record<string, unknown>): SshKey {
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    name: String(row.name),
    algorithm: String(row.algorithm),
    fingerprint: String(row.fingerprint),
    comment: String(row.comment),
    addedFrom: source(row),
    createdAt: String(row.created_at),
    lastUsedAt: nullable(row.last_used_at),
    revokedAt: nullable(row.revoked_at),
  }
}

const SELECT = `SELECT k.id, k.agent_id, k.name, k.algorithm, k.fingerprint, k.comment, k.added_via,
    k.added_by_token_id, k.added_by_grant_id, u.name AS user_name, t.created_at AS token_created_at,
    g.client_name AS grant_client_name, k.created_at, k.last_used_at, k.revoked_at
  FROM agent_ssh_keys k
  LEFT JOIN users u ON u.id = k.added_by_user_id
  LEFT JOIN agent_tokens t ON t.id = k.added_by_token_id
  LEFT JOIN oauth_grants g ON g.id = k.added_by_grant_id`

function getSshKey(db: DatabaseSync, id: number): SshKey | undefined {
  const row = db.prepare(`${SELECT} WHERE k.id = ?`).get(id)
  return row ? toKey(row) : undefined
}

export function addSshKey(db: DatabaseSync, agentId: number, name: string, publicKey: string, addedBy: AddedBy): SshKey {
  const keyName = name.trim()
  if (!keyName) throw new SshKeyError('Give the SSH key a name')
  if (keyName.length > MAX_SSH_KEY_NAME) throw new SshKeyError(`Use at most ${MAX_SSH_KEY_NAME} characters for the name`)
  const { algorithm, keyData, comment } = parsePublicKey(publicKey)
  const existing = db.prepare('SELECT agent_id FROM agent_ssh_keys WHERE key_data = ? AND revoked_at IS NULL').get(keyData)
  if (existing) {
    const owner = getAgent(db, Number(existing.agent_id))
    throw new SshKeyError(`This key is already registered${owner ? ` to ${owner.name}` : ''}`)
  }
  const credential = addedBy.via === 'agent' ? addedBy.credential : undefined
  const row = db
    .prepare(
      `INSERT INTO agent_ssh_keys
         (agent_id, name, algorithm, key_data, fingerprint, comment, added_via, added_by_user_id, added_by_token_id, added_by_grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      agentId,
      keyName,
      algorithm,
      keyData,
      fingerprint(Buffer.from(keyData, 'base64')),
      comment,
      addedBy.via,
      addedBy.via === 'web' ? addedBy.userId : null,
      credential?.kind === 'token' ? credential.id : null,
      credential?.kind === 'grant' ? credential.id : null,
    )
  const key = row && getSshKey(db, Number(row.id))
  if (!key) throw new Error('SSH key insert returned no row')
  return key
}

export function listSshKeys(db: DatabaseSync, agentId?: number): SshKey[] {
  const rows =
    agentId === undefined
      ? db.prepare(`${SELECT} ORDER BY k.id DESC`).all()
      : db.prepare(`${SELECT} WHERE k.agent_id = ? ORDER BY k.id DESC`).all(agentId)
  return rows.map(toKey)
}

// Returns false when the key does not exist, is already revoked or, with
// agentId, belongs to another agent.
export function revokeSshKey(db: DatabaseSync, id: number, agentId?: number): boolean {
  const result = db
    .prepare(
      `UPDATE agent_ssh_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND revoked_at IS NULL AND (? IS NULL OR agent_id = ?)`,
    )
    .run(id, agentId ?? null, agentId ?? null)
  return Number(result.changes) > 0
}

// The agent a public key (SSH wire format) belongs to, with the key to verify
// signatures. A key an agent added has the access of the token or connection
// it used, so a limited credential cannot give itself wider access over SSH.
export function findSshKey(
  db: DatabaseSync,
  keyData: Buffer,
): { id: number; agent: AuthenticatedAgent; key: ParsedKey } | undefined {
  const row = db
    .prepare(
      `SELECT id, agent_id, algorithm, key_data, added_by_token_id, added_by_grant_id
       FROM agent_ssh_keys WHERE key_data = ? AND revoked_at IS NULL`,
    )
    .get(keyData.toString('base64'))
  if (!row) return undefined
  const agent = getAgent(db, Number(row.agent_id))
  const key = ssh2.utils.parseKey(`${String(row.algorithm)} ${String(row.key_data)}`)
  if (!agent || key instanceof Error || Array.isArray(key)) return undefined
  const access =
    row.added_by_token_id !== null
      ? loadAccess(db, 'token', Number(row.added_by_token_id))
      : row.added_by_grant_id !== null
        ? loadAccess(db, 'grant', Number(row.added_by_grant_id))
        : FULL_ACCESS
  return { id: Number(row.id), agent: { ...agent, access }, key }
}

export function markSshKeyUsed(db: DatabaseSync, id: number): void {
  db.prepare(`UPDATE agent_ssh_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id)
}
