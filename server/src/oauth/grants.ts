import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { createAgent, getAgent, type Agent } from '../agents.ts'
import type { OAuthClient } from './clients.ts'
import { hashSecret, newSecret, s256 } from './secrets.ts'

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
// Every refresh issues a new refresh token with a fresh lifetime, so a client
// in regular use stays connected and an abandoned one expires.
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const CODE_TTL_MS = 5 * 60 * 1000
export const REQUEST_TTL_MS = 15 * 60 * 1000

export const ACCESS_TOKEN_PREFIX = 'hwa_'
const REFRESH_TOKEN_PREFIX = 'hwr_'

export class OAuthError extends Error {
  code: string
  status: number
  constructor(code: string, description: string, status = 400) {
    super(description)
    this.code = code
    this.status = status
  }
}

export type AuthorizationRequest = {
  id: string
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  resource: string
  scope: string | null
}

export type TokenResponse = {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope?: string
}

const iso = (ms: number) => new Date(ms).toISOString()

export function saveRequest(db: DatabaseSync, request: Omit<AuthorizationRequest, 'id'>, now: number): string {
  db.prepare('DELETE FROM oauth_requests WHERE expires_at <= ?').run(iso(now))
  const id = randomBytes(24).toString('base64url')
  db.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, resource, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    request.clientId,
    request.redirectUri,
    request.state,
    request.codeChallenge,
    request.resource,
    request.scope,
    iso(now + REQUEST_TTL_MS),
  )
  return id
}

export function getRequest(db: DatabaseSync, id: string, now: number): AuthorizationRequest | undefined {
  const row = db.prepare('SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?').get(id, iso(now))
  if (!row) return undefined
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    state: row.state === null ? null : String(row.state),
    codeChallenge: String(row.code_challenge),
    resource: String(row.resource),
    scope: row.scope === null ? null : String(row.scope),
  }
}

export function deleteRequest(db: DatabaseSync, id: string) {
  db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(id)
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    // A refused request keeps its writes: revoking a grant on code or refresh
    // token reuse has to stick although the request fails.
    db.exec(err instanceof OAuthError ? 'COMMIT' : 'ROLLBACK')
    throw err
  }
}

// Creates the agent and its grant and returns the one-time authorization code,
// or undefined when the request was already answered.
export function approveRequest(
  db: DatabaseSync,
  options: { request: AuthorizationRequest; client: OAuthClient; agentName: string; userId: number; now: number },
): { code: string; agent: Agent } | undefined {
  const { request, client, agentName, userId, now } = options
  return transaction(db, () => {
    const pending = db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(request.id)
    if (Number(pending.changes) === 0) return undefined
    const agent = createAgent(db, agentName)
    const grant = db
      .prepare(
        `INSERT INTO oauth_grants (agent_id, client_id, client_name, redirect_host, resource, scope, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        agent.id,
        client.id,
        client.name,
        new URL(request.redirectUri).host,
        request.resource,
        request.scope,
        userId,
        iso(now),
      )
    if (!grant) throw new Error('Grant insert returned no row')
    const code = randomBytes(32).toString('base64url')
    db.prepare(
      'INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(hashSecret(code), Number(grant.id), request.redirectUri, request.codeChallenge, iso(now + CODE_TTL_MS))
    return { code, agent }
  })
}

// Ends a grant and every token issued under it.
export function revokeGrant(db: DatabaseSync, grantId: number, now = Date.now()): boolean {
  const result = db
    .prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(iso(now), grantId)
  db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(iso(now), grantId)
  return Number(result.changes) > 0
}

type GrantRow = { id: number; clientId: string; resource: string; scope: string | null; revoked: boolean }

function grantById(db: DatabaseSync, id: number): GrantRow | undefined {
  const row = db.prepare('SELECT id, client_id, resource, scope, revoked_at FROM oauth_grants WHERE id = ?').get(id)
  if (!row) return undefined
  return {
    id: Number(row.id),
    clientId: String(row.client_id),
    resource: String(row.resource),
    scope: row.scope === null ? null : String(row.scope),
    revoked: row.revoked_at !== null,
  }
}

function issueTokens(db: DatabaseSync, grant: GrantRow, now: number): TokenResponse {
  // Expired tokens are useless; used refresh tokens are kept until they
  // expire so that a replay is still recognized.
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(iso(now))
  db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(iso(now))
  const access = newSecret(ACCESS_TOKEN_PREFIX)
  const refresh = newSecret(REFRESH_TOKEN_PREFIX)
  const insert = db.prepare('INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at) VALUES (?, ?, ?, ?)')
  insert.run(grant.id, 'access', hashSecret(access), iso(now + ACCESS_TOKEN_TTL_SECONDS * 1000))
  insert.run(grant.id, 'refresh', hashSecret(refresh), iso(now + REFRESH_TOKEN_TTL_SECONDS * 1000))
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    ...(grant.scope ? { scope: grant.scope } : {}),
  }
}

function checkResource(grant: GrantRow, resource: string | undefined) {
  if (resource !== undefined && resource !== grant.resource) {
    throw new OAuthError('invalid_target', 'The resource does not match the one this access was granted for')
  }
}

export function exchangeCode(
  db: DatabaseSync,
  options: {
    client: OAuthClient
    code: string
    redirectUri: string | undefined
    verifier: string | undefined
    resource: string | undefined
    now: number
  },
): TokenResponse {
  const { client, code, redirectUri, verifier, resource, now } = options
  return transaction(db, () => {
    const row = db
      .prepare('SELECT grant_id, redirect_uri, code_challenge, expires_at, used_at FROM oauth_codes WHERE code_hash = ?')
      .get(hashSecret(code))
    const grant = row && grantById(db, Number(row.grant_id))
    if (!row || !grant || grant.clientId !== client.id) throw new OAuthError('invalid_grant', 'Unknown authorization code')
    if (row.used_at !== null) {
      // OAuth 2.1 4.1.3: a code used twice may have been stolen, so everything
      // issued with it is revoked.
      revokeGrant(db, grant.id, now)
      throw new OAuthError('invalid_grant', 'This authorization code was already used')
    }
    if (String(row.expires_at) <= iso(now)) throw new OAuthError('invalid_grant', 'The authorization code expired')
    if (grant.revoked) throw new OAuthError('invalid_grant', 'This access was revoked')
    if (redirectUri !== String(row.redirect_uri)) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
    }
    if (!verifier || s256(verifier) !== String(row.code_challenge)) {
      throw new OAuthError('invalid_grant', 'code_verifier does not match the code challenge')
    }
    checkResource(grant, resource)
    db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?').run(iso(now), hashSecret(code))
    return issueTokens(db, grant, now)
  })
}

export function refreshTokens(
  db: DatabaseSync,
  options: { client: OAuthClient; refreshToken: string; resource: string | undefined; now: number },
): TokenResponse {
  const { client, refreshToken, resource, now } = options
  return transaction(db, () => {
    const row = db
      .prepare(
        `SELECT id, grant_id, expires_at, used_at, revoked_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`,
      )
      .get(hashSecret(refreshToken))
    const grant = row && grantById(db, Number(row.grant_id))
    if (!row || !grant || grant.clientId !== client.id) throw new OAuthError('invalid_grant', 'Unknown refresh token')
    if (row.used_at !== null) {
      // The token was rotated before, so either the client or an attacker holds
      // a copy. Revoking the grant stops both (OAuth 2.1 4.3.1).
      revokeGrant(db, grant.id, now)
      throw new OAuthError('invalid_grant', 'This refresh token was already used')
    }
    if (grant.revoked || row.revoked_at !== null) throw new OAuthError('invalid_grant', 'This access was revoked')
    if (String(row.expires_at) <= iso(now)) throw new OAuthError('invalid_grant', 'The refresh token expired')
    checkResource(grant, resource)
    db.prepare('UPDATE oauth_tokens SET used_at = ? WHERE id = ?').run(iso(now), Number(row.id))
    return issueTokens(db, grant, now)
  })
}

// RFC 7009: unknown tokens and tokens of other clients are ignored. Revoking a
// refresh token ends the whole grant, since its access tokens came from it.
export function revokeToken(db: DatabaseSync, client: OAuthClient, token: string, now: number) {
  const row = db
    .prepare('SELECT t.id, t.kind, t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?')
    .get(hashSecret(token))
  if (!row || String(row.client_id) !== client.id) return
  if (row.kind === 'refresh') revokeGrant(db, Number(row.grant_id), now)
  else db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(iso(now), Number(row.id))
}

export function verifyAccessToken(db: DatabaseSync, token: string, resource: string, now = Date.now()): Agent | undefined {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return undefined
  const row = db
    .prepare(
      `SELECT g.id AS grant_id, g.agent_id, g.resource FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
       WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL AND g.revoked_at IS NULL AND t.expires_at > ?`,
    )
    .get(hashSecret(token), iso(now))
  // RFC 8707: a token issued for another resource is not accepted here.
  if (!row || String(row.resource) !== resource) return undefined
  db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(iso(now), Number(row.grant_id))
  return getAgent(db, Number(row.agent_id))
}

export type Connection = {
  id: number
  clientName: string
  redirectHost: string
  connectedBy: string | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export function listConnections(db: DatabaseSync): Map<number, Connection[]> {
  const byAgent = new Map<number, Connection[]>()
  for (const row of db
    .prepare(
      `SELECT g.id, g.agent_id, g.client_name, g.redirect_host, u.name AS user_name, g.created_at, g.last_used_at, g.revoked_at
       FROM oauth_grants g LEFT JOIN users u ON u.id = g.user_id ORDER BY g.id DESC`,
    )
    .all()) {
    const list = byAgent.get(Number(row.agent_id)) ?? []
    list.push({
      id: Number(row.id),
      clientName: String(row.client_name),
      redirectHost: String(row.redirect_host),
      connectedBy: row.user_name === null ? null : String(row.user_name),
      createdAt: String(row.created_at),
      lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    })
    byAgent.set(Number(row.agent_id), list)
  }
  return byAgent
}
