import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { FULL_ACCESS, loadAccess, loadAllAccess, saveAccess, type Access } from './access.ts'

export type Agent = { id: number; name: string }

// What an agent authenticated with: a static agent token or an OAuth grant.
export type Credential = { kind: 'token'; id: number } | { kind: 'grant'; id: number }

// Without a credential (an SSH key a person added) the agent has full access.
export type AuthenticatedAgent = Agent & { credential?: Credential; access: Access }

const TOKEN_PREFIX = 'hw_'

// Tokens are 256 random bits, so a fast unsalted hash is enough to make a leaked
// DB useless without making every request pay for a slow KDF.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Creates the agent unless one with this name exists.
export function ensureAgent(db: DatabaseSync, agentName: string): Agent {
  if (!agentName.trim()) throw new Error('Agent name must not be empty')
  const row = db
    .prepare(
      `INSERT INTO agents (name) VALUES (?)
       ON CONFLICT (name) DO UPDATE SET name = excluded.name
       RETURNING id, name`,
    )
    .get(agentName)
  if (!row) throw new Error('Agent upsert returned no row')
  return { id: Number(row.id), name: String(row.name) }
}

export function createAgentToken(
  db: DatabaseSync,
  agentName: string,
  access: Access = FULL_ACCESS,
): { agent: Agent; token: string } {
  const agent = ensureAgent(db, agentName)
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const row = db
    .prepare('INSERT INTO agent_tokens (agent_id, token_hash) VALUES (?, ?) RETURNING id')
    .get(agent.id, hashToken(token))
  if (!row) throw new Error('Token insert returned no row')
  saveAccess(db, 'token', Number(row.id), access)
  return { agent, token }
}

export const MAX_AGENT_NAME = 64

export function agentNameTaken(db: DatabaseSync, name: string): boolean {
  return db.prepare('SELECT 1 FROM agents WHERE name = ?').get(name) !== undefined
}

// "Claude", then "Claude 2", "Claude 3", ... so a suggested name is free.
export function freeAgentName(db: DatabaseSync, base: string): string {
  const trimmed = base.trim().slice(0, MAX_AGENT_NAME - 4) || 'Agent'
  if (!agentNameTaken(db, trimmed)) return trimmed
  for (let n = 2; ; n++) {
    const name = `${trimmed} ${n}`
    if (!agentNameTaken(db, name)) return name
  }
}

// Throws when the name is taken, so callers check agentNameTaken first to show a message.
export function createAgent(db: DatabaseSync, name: string): Agent {
  const row = db.prepare('INSERT INTO agents (name) VALUES (?) RETURNING id, name').get(name)
  if (!row) throw new Error('Agent insert returned no row')
  return { id: Number(row.id), name: String(row.name) }
}

export type AgentToken = {
  id: number
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  access: Access
}

export type AgentWithTokens = Agent & { createdAt: string; tokens: AgentToken[] }

function nullableString(value: unknown): string | null {
  return value === null ? null : String(value)
}

export function getAgent(db: DatabaseSync, id: number): Agent | undefined {
  const row = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(id)
  return row ? { id: Number(row.id), name: String(row.name) } : undefined
}

export function listAgents(db: DatabaseSync): AgentWithTokens[] {
  const tokens = new Map<number, AgentToken[]>()
  const access = loadAllAccess(db, 'token')
  for (const row of db
    .prepare('SELECT id, agent_id, created_at, last_used_at, revoked_at FROM agent_tokens ORDER BY id DESC')
    .all()) {
    const list = tokens.get(Number(row.agent_id)) ?? []
    list.push({
      id: Number(row.id),
      createdAt: String(row.created_at),
      lastUsedAt: nullableString(row.last_used_at),
      revokedAt: nullableString(row.revoked_at),
      access: access.get(Number(row.id)) ?? FULL_ACCESS,
    })
    tokens.set(Number(row.agent_id), list)
  }
  return db
    .prepare('SELECT id, name, created_at FROM agents ORDER BY name')
    .all()
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      createdAt: String(row.created_at),
      tokens: tokens.get(Number(row.id)) ?? [],
    }))
}

// Returns false when the token does not exist or was already revoked. Also
// revokes the SSH keys the agent added with this token.
export function revokeAgentToken(db: DatabaseSync, tokenId: number): boolean {
  const result = db
    .prepare(
      `UPDATE agent_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(tokenId)
  db.prepare(
    `UPDATE agent_ssh_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE added_by_token_id = ? AND revoked_at IS NULL`,
  ).run(tokenId)
  return Number(result.changes) > 0
}

export function verifyAgentToken(db: DatabaseSync, token: string): AuthenticatedAgent | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined
  const row = db
    .prepare(
      `UPDATE agent_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE token_hash = ? AND revoked_at IS NULL
       RETURNING id, agent_id`,
    )
    .get(hashToken(token))
  const agent = row && getAgent(db, Number(row.agent_id))
  if (!agent) return undefined
  return { ...agent, credential: { kind: 'token', id: Number(row.id) }, access: loadAccess(db, 'token', Number(row.id)) }
}
