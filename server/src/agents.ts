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

export function verifyAgentToken(db: DatabaseSync, token: string): Agent | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined
  const row = db
    .prepare(
      `UPDATE agent_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE token_hash = ? AND revoked_at IS NULL
       RETURNING agent_id`,
    )
    .get(hashToken(token))
  if (!row) return undefined
  const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(row.agent_id as number)
  return agent ? { id: Number(agent.id), name: String(agent.name) } : undefined
}
