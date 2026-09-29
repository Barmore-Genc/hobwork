import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import ssh2, { type ParsedKey } from 'ssh2'
import { getAgent, type Agent } from '../agents.ts'

export type SshKey = {
  id: number
  agentId: number
  algorithm: string
  fingerprint: string
  comment: string
  createdAt: string
  lastUsedAt: string | null
}

export class SshKeyError extends Error {}

const MAX_KEY_CHARS = 16 * 1024

// Same format as `ssh-keygen -l`.
export function fingerprint(keyData: Buffer): string {
  return `SHA256:${createHash('sha256').update(keyData).digest('base64').replace(/=+$/, '')}`
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

function toKey(row: Record<string, unknown>): SshKey {
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    algorithm: String(row.algorithm),
    fingerprint: String(row.fingerprint),
    comment: String(row.comment),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
  }
}

const COLUMNS = 'id, agent_id, algorithm, fingerprint, comment, created_at, last_used_at'

export function addSshKey(db: DatabaseSync, agentId: number, publicKey: string): SshKey {
  const { algorithm, keyData, comment } = parsePublicKey(publicKey)
  const existing = db.prepare('SELECT agent_id FROM agent_ssh_keys WHERE key_data = ?').get(keyData)
  if (existing) {
    const owner = getAgent(db, Number(existing.agent_id))
    throw new SshKeyError(`This key is already registered${owner ? ` to ${owner.name}` : ''}`)
  }
  const row = db
    .prepare(
      `INSERT INTO agent_ssh_keys (agent_id, algorithm, key_data, fingerprint, comment)
       VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    )
    .get(agentId, algorithm, keyData, fingerprint(Buffer.from(keyData, 'base64')), comment)
  if (!row) throw new Error('SSH key insert returned no row')
  return toKey(row)
}

export function listSshKeys(db: DatabaseSync): SshKey[] {
  return db.prepare(`SELECT ${COLUMNS} FROM agent_ssh_keys ORDER BY id DESC`).all().map(toKey)
}

// Returns false when the key does not exist.
export function deleteSshKey(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare('DELETE FROM agent_ssh_keys WHERE id = ?').run(id).changes) > 0
}

// The agent a public key (SSH wire format) belongs to, with the key to verify signatures.
export function findSshKey(db: DatabaseSync, keyData: Buffer): { id: number; agent: Agent; key: ParsedKey } | undefined {
  const row = db
    .prepare('SELECT id, agent_id, algorithm, key_data FROM agent_ssh_keys WHERE key_data = ?')
    .get(keyData.toString('base64'))
  if (!row) return undefined
  const agent = getAgent(db, Number(row.agent_id))
  const key = ssh2.utils.parseKey(`${String(row.algorithm)} ${String(row.key_data)}`)
  if (!agent || key instanceof Error || Array.isArray(key)) return undefined
  return { id: Number(row.id), agent, key }
}

export function markSshKeyUsed(db: DatabaseSync, id: number): void {
  db.prepare(`UPDATE agent_ssh_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id)
}
