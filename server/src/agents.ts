import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'

export type Agent = { id: number; name: string }

const TOKEN_PREFIX = 'hw_'

// Tokens are 256 random bits, so a fast unsalted hash is enough to make a leaked
// DB useless without making every request pay for a slow KDF.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createAgentToken(db: DatabaseSync, agentName: string): { agent: Agent; token: string } {
  if (!agentName.trim()) throw new Error('Agent name must not be empty')
  const row = db
    .prepare(
      `INSERT INTO agents (name) VALUES (?)
       ON CONFLICT (name) DO UPDATE SET name = excluded.name
       RETURNING id, name`,
    )
    .get(agentName)
  if (!row) throw new Error('Agent upsert returned no row')
  const agent = { id: Number(row.id), name: String(row.name) }
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO agent_tokens (agent_id, token_hash) VALUES (?, ?)').run(
    agent.id,
    hashToken(token),
  )
  return { agent, token }
}

export type AgentToken = {
  id: number
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
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
  for (const row of db
    .prepare('SELECT id, agent_id, created_at, last_used_at, revoked_at FROM agent_tokens ORDER BY id DESC')
    .all()) {
    const list = tokens.get(Number(row.agent_id)) ?? []
    list.push({
      id: Number(row.id),
      createdAt: String(row.created_at),
      lastUsedAt: nullableString(row.last_used_at),
      revokedAt: nullableString(row.revoked_at),
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

// Returns false when the token does not exist or was already revoked.
export function revokeAgentToken(db: DatabaseSync, tokenId: number): boolean {
  const result = db
    .prepare(
      `UPDATE agent_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(tokenId)
  return Number(result.changes) > 0
}

export function verifyAgentToken(db: DatabaseSync, token: string): Agent | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined
  const row = db
    .prepare(
      `UPDATE agent_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE token_hash = ? AND revoked_at IS NULL
       RETURNING agent_id`,
    )
    .get(hashToken(token))
  return row ? getAgent(db, Number(row.agent_id)) : undefined
}
