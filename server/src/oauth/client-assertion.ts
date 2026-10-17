import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { OAuthClient } from './clients.ts'
import { OAuthError } from './grants.ts'
import type { FetchedDocument } from './metadata-fetch.ts'

export const JWT_BEARER_ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
export const ASSERTION_ALGS = ['RS256', 'ES256']

const CLOCK_SKEW_SECONDS = 60
// The jti of every assertion is kept until it expires, so long-lived ones are refused.
const MAX_LIFETIME_SECONDS = 60 * 60
const MAX_JTI = 256
const MIN_RSA_BITS = 2048
const DEFAULT_CACHE_SECONDS = 60 * 60
const MIN_CACHE_SECONDS = 60
const MAX_CACHE_SECONDS = 24 * 60 * 60
// A kid missing from the cached JWKS means the client rotated its keys, but
// assertions are unauthenticated input, so refetching is limited.
const MIN_REFETCH_MS = 60 * 1000

type Jwt = { header: Record<string, unknown>; claims: Record<string, unknown>; signed: Buffer; signature: Buffer }

const fail = (message: string) => new OAuthError('invalid_client', message, 401)

function decodePart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
  return value as Record<string, unknown>
}

function parseJwt(assertion: string): Jwt {
  const parts = assertion.split('.')
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) throw fail('client_assertion is not a signed JWT')
  try {
    return {
      header: decodePart(parts[0]!),
      claims: decodePart(parts[1]!),
      signed: Buffer.from(`${parts[0]}.${parts[1]}`),
      signature: Buffer.from(parts[2]!, 'base64url'),
    }
  } catch {
    throw fail('client_assertion is not a signed JWT')
  }
}

// The client ID a client_assertion names, for token requests without client_id (RFC 7523 3).
export function assertionSubject(assertion: string): string | undefined {
  try {
    const { sub } = parseJwt(assertion).claims
    return typeof sub === 'string' ? sub : undefined
  } catch {
    return undefined
  }
}

function keyFor(jwk: unknown, alg: string, kid: unknown): KeyObject | undefined {
  if (typeof jwk !== 'object' || jwk === null) return undefined
  const key = jwk as Record<string, unknown>
  if (kid !== undefined && key.kid !== kid) return undefined
  if (key.use !== undefined && key.use !== 'sig') return undefined
  if (key.alg !== undefined && key.alg !== alg) return undefined
  if (alg === 'RS256' && key.kty !== 'RSA') return undefined
  if (alg === 'ES256' && (key.kty !== 'EC' || key.crv !== 'P-256')) return undefined
  try {
    const object = createPublicKey({ key: key as JsonWebKey, format: 'jwk' })
    if (alg === 'RS256' && (object.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) return undefined
    return object
  } catch {
    return undefined
  }
}

function signatureValid(jwt: Jwt, alg: string, key: KeyObject): boolean {
  return verify('sha256', jwt.signed, alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, jwt.signature)
}

function maxAgeMs(seconds: number | undefined): number {
  return Math.min(MAX_CACHE_SECONDS, Math.max(MIN_CACHE_SECONDS, seconds ?? DEFAULT_CACHE_SECONDS)) * 1000
}

export function createAssertionVerifier(options: {
  db: DatabaseSync
  fetchDocument: (url: URL) => Promise<FetchedDocument>
  now: () => number
}) {
  const { db, fetchDocument, now } = options
  const jwksCache = new Map<string, { keys: unknown[]; fetchedAt: number; expiresAt: number }>()

  async function jwks(uri: string, refetch: boolean): Promise<unknown[]> {
    const cached = jwksCache.get(uri)
    if (cached && cached.expiresAt > now() && (!refetch || now() - cached.fetchedAt < MIN_REFETCH_MS)) return cached.keys
    let fetched: FetchedDocument
    try {
      fetched = await fetchDocument(new URL(uri))
    } catch (err) {
      throw fail(`Could not load the client's JWKS: ${(err as Error).message}`)
    }
    const keys = (fetched.body as { keys?: unknown } | null)?.keys
    if (!Array.isArray(keys)) throw fail(`The client's JWKS at ${uri} has no keys`)
    if (jwksCache.size > 100) jwksCache.clear()
    jwksCache.set(uri, { keys, fetchedAt: now(), expiresAt: now() + maxAgeMs(fetched.maxAgeSeconds) })
    return keys
  }

  async function checkSignature(client: OAuthClient, jwt: Jwt) {
    const alg = jwt.header.alg
    if (typeof alg !== 'string' || !ASSERTION_ALGS.includes(alg)) {
      throw fail(`client_assertion must be signed with ${ASSERTION_ALGS.join(' or ')}`)
    }
    const candidates = async (refetch: boolean) =>
      (await jwks(client.jwksUri!, refetch)).map((jwk) => keyFor(jwk, alg, jwt.header.kid)).filter((k) => k !== undefined)
    let keys = await candidates(false)
    if (keys.length === 0) keys = await candidates(true)
    if (keys.length === 0) throw fail("No key in the client's JWKS matches the client_assertion")
    if (!keys.some((key) => signatureValid(jwt, alg, key))) throw fail('The client_assertion signature is not valid')
  }

  // RFC 7523 3. audiences are the identifiers of this server the assertion may name.
  function checkClaims(client: OAuthClient, claims: Record<string, unknown>, audiences: string[]): { jti: string; exp: number } {
    const seconds = Math.floor(now() / 1000)
    if (claims.iss !== client.id || claims.sub !== client.id) throw fail('client_assertion iss and sub must be the client_id')
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.some((a) => typeof a === 'string' && audiences.includes(a))) {
      throw fail(`client_assertion aud must be ${audiences.join(' or ')}`)
    }
    const { exp, nbf, iat, jti } = claims
    if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS <= seconds) throw fail('client_assertion is expired or has no exp')
    if (exp > seconds + MAX_LIFETIME_SECONDS) throw fail(`client_assertion must expire within ${MAX_LIFETIME_SECONDS} seconds`)
    if (nbf !== undefined && (typeof nbf !== 'number' || nbf > seconds + CLOCK_SKEW_SECONDS)) throw fail('client_assertion is not valid yet')
    if (iat !== undefined && (typeof iat !== 'number' || iat > seconds + CLOCK_SKEW_SECONDS)) throw fail('client_assertion is issued in the future')
    if (typeof jti !== 'string' || !jti || jti.length > MAX_JTI) throw fail('client_assertion needs a jti')
    return { jti, exp }
  }

  function useOnce(client: OAuthClient, jti: string, exp: number) {
    db.prepare('DELETE FROM oauth_client_assertions WHERE expires_at <= ?').run(new Date(now()).toISOString())
    const inserted = db
      .prepare('INSERT INTO oauth_client_assertions (client_id, jti, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .run(client.id, jti, new Date((exp + CLOCK_SKEW_SECONDS) * 1000).toISOString())
    if (inserted.changes === 0) throw fail('This client_assertion was already used')
  }

  return {
    // Throws OAuthError invalid_client unless the assertion authenticates the client.
    async verify(client: OAuthClient, assertion: string, audiences: string[]) {
      if (!client.jwksUri) throw fail('This client has no JWKS')
      const jwt = parseJwt(assertion)
      const { jti, exp } = checkClaims(client, jwt.claims, audiences)
      await checkSignature(client, jwt)
      useOnce(client, jti, exp)
    },
  }
}
