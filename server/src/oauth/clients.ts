import type { DatabaseSync } from 'node:sqlite'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { hashSecret } from './secrets.ts'
import type { FetchedDocument } from './metadata-fetch.ts'

export type AuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post'
export const AUTH_METHODS: AuthMethod[] = ['none', 'client_secret_basic', 'client_secret_post']

export type OAuthClient = {
  id: string
  name: string
  uri: string | null
  redirectUris: string[]
  authMethod: AuthMethod
  // Metadata documents are served from the client's own domain, so their
  // client ID vouches for where they come from. Registered clients name themselves.
  kind: 'metadata-document' | 'registered'
  secretHash: string | null
}

export class ClientError extends Error {
  code: 'invalid_client' | 'invalid_client_metadata' | 'invalid_redirect_uri'
  constructor(code: ClientError['code'], message: string) {
    super(message)
    this.code = code
  }
}

const MAX_NAME = 100
const MAX_REDIRECT_URIS = 10
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000
// Registration is open, so the clients nobody approved yet are capped.
export const MAX_UNUSED_CLIENTS = 200
const DEFAULT_CACHE_SECONDS = 60 * 60
const MIN_CACHE_SECONDS = 60
const MAX_CACHE_SECONDS = 24 * 60 * 60

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopback(uri: string): boolean {
  const url = new URL(uri)
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

// The MCP spec allows only https and loopback redirects.
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash || url.username || url.password) return false
  return url.protocol === 'https:' || isLoopback(value)
}

// Exact match, except that loopback redirects match on any port: native
// clients like Claude Code listen on a port picked per session (RFC 8252 7.3).
export function redirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  if (client.redirectUris.includes(redirectUri)) return true
  let requested: URL
  try {
    requested = new URL(redirectUri)
  } catch {
    return false
  }
  if (!isLoopback(redirectUri)) return false
  return client.redirectUris.some((registered) => {
    if (!isLoopback(registered)) return false
    const url = new URL(registered)
    return (
      url.hostname === requested.hostname &&
      url.pathname === requested.pathname &&
      url.search === requested.search
    )
  })
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/\s+/g, ' ').trim()
  return name ? name.slice(0, MAX_NAME) : undefined
}

function httpsUri(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

// Grant types Hobwork does not offer are ignored rather than refused: Claude's
// metadata document also lists the JWT bearer grant, for example.
function checkGrantTypes(value: unknown) {
  if (value === undefined) return
  if (!Array.isArray(value) || !value.includes('authorization_code')) {
    throw new ClientError('invalid_client_metadata', 'grant_types must include authorization_code')
  }
}

function checkResponseTypes(value: unknown) {
  if (value === undefined) return
  if (!Array.isArray(value) || !value.every((t) => t === 'code')) {
    throw new ClientError('invalid_client_metadata', 'Only the code response type is supported')
  }
}

function checkRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) {
    throw new ClientError('invalid_redirect_uri', `Give 1 to ${MAX_REDIRECT_URIS} redirect_uris`)
  }
  if (!value.every(validRedirectUri)) {
    throw new ClientError('invalid_redirect_uri', 'Redirect URIs must use https or http on localhost, without a fragment')
  }
  return value
}

// A client ID that is an https URL with a path points to a metadata document.
export function isMetadataDocumentUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' && url.pathname !== '/' && !url.hash && !url.username && !url.password
  } catch {
    return false
  }
}

export function clientFromMetadataDocument(clientId: string, document: unknown): OAuthClient {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new ClientError('invalid_client', 'The client metadata document is not a JSON object')
  }
  const doc = document as Record<string, unknown>
  if (doc.client_id !== clientId) {
    throw new ClientError('invalid_client', 'The client metadata document has a different client_id')
  }
  const name = cleanName(doc.client_name)
  if (!name) throw new ClientError('invalid_client', 'The client metadata document has no client_name')
  const method = doc.token_endpoint_auth_method ?? 'none'
  if (method !== 'none') {
    throw new ClientError('invalid_client', 'Clients with a metadata document must use token_endpoint_auth_method "none"')
  }
  try {
    checkGrantTypes(doc.grant_types)
    checkResponseTypes(doc.response_types)
    return {
      id: clientId,
      name,
      uri: httpsUri(doc.client_uri),
      redirectUris: checkRedirectUris(doc.redirect_uris),
      authMethod: 'none',
      kind: 'metadata-document',
      secretHash: null,
    }
  } catch (err) {
    if (err instanceof ClientError) throw new ClientError('invalid_client', err.message)
    throw err
  }
}

export type RegisteredClient = { client: OAuthClient; secret: string | undefined }

// RFC 7591 registration. The request is untrusted, so only the fields Hobwork
// uses are kept.
export function registerClient(db: DatabaseSync, body: unknown, now = Date.now()): RegisteredClient {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ClientError('invalid_client_metadata', 'Send the client metadata as a JSON object')
  }
  const meta = body as Record<string, unknown>
  const redirectUris = checkRedirectUris(meta.redirect_uris)
  checkGrantTypes(meta.grant_types)
  checkResponseTypes(meta.response_types)
  // RFC 7591 2: the default is client_secret_basic.
  const authMethod = meta.token_endpoint_auth_method ?? 'client_secret_basic'
  if (!AUTH_METHODS.includes(authMethod as AuthMethod)) {
    throw new ClientError('invalid_client_metadata', `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`)
  }
  const secret = authMethod === 'none' ? undefined : randomBytes(32).toString('base64url')
  const client: OAuthClient = {
    id: `hwc_${randomBytes(16).toString('base64url')}`,
    name: cleanName(meta.client_name) ?? new URL(redirectUris[0]!).host,
    uri: httpsUri(meta.client_uri),
    redirectUris,
    authMethod: authMethod as AuthMethod,
    kind: 'registered',
    secretHash: secret ? hashSecret(secret) : null,
  }
  db.prepare(
    `DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants)`,
  ).run(new Date(now - UNUSED_CLIENT_TTL_MS).toISOString())
  // Room is made by dropping the oldest, so a flood of registrations cannot
  // keep a real client from registering.
  db.prepare(
    `DELETE FROM oauth_clients WHERE id IN (
       SELECT id FROM oauth_clients WHERE id NOT IN (SELECT client_id FROM oauth_grants)
       ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
  ).run(MAX_UNUSED_CLIENTS - 1)
  db.prepare(
    'INSERT INTO oauth_clients (id, name, uri, redirect_uris, secret_hash, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    client.id,
    client.name,
    client.uri,
    JSON.stringify(client.redirectUris),
    client.secretHash,
    client.authMethod,
    new Date(now).toISOString(),
  )
  return { client, secret }
}

function registeredClient(db: DatabaseSync, id: string): OAuthClient | undefined {
  const row = db.prepare('SELECT id, name, uri, redirect_uris, secret_hash, auth_method FROM oauth_clients WHERE id = ?').get(id)
  if (!row) return undefined
  return {
    id: String(row.id),
    name: String(row.name),
    uri: row.uri === null ? null : String(row.uri),
    redirectUris: JSON.parse(String(row.redirect_uris)) as string[],
    authMethod: String(row.auth_method) as AuthMethod,
    kind: 'registered',
    secretHash: row.secret_hash === null ? null : String(row.secret_hash),
  }
}

export function secretMatches(client: OAuthClient, secret: string): boolean {
  if (!client.secretHash) return false
  const a = Buffer.from(hashSecret(secret))
  const b = Buffer.from(client.secretHash)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type ClientStore = ReturnType<typeof createClientStore>

export function createClientStore(options: {
  db: DatabaseSync
  fetchDocument: (url: URL) => Promise<FetchedDocument>
  now: () => number
}) {
  const { db, fetchDocument, now } = options
  const cache = new Map<string, { client: OAuthClient; expiresAt: number }>()

  return {
    // Throws ClientError when the client is unknown or its document is unusable.
    async get(clientId: string): Promise<OAuthClient> {
      if (!isMetadataDocumentUrl(clientId)) {
        const client = registeredClient(db, clientId)
        if (!client) throw new ClientError('invalid_client', 'This client is not registered with Hobwork')
        return client
      }
      const cached = cache.get(clientId)
      if (cached && cached.expiresAt > now()) return cached.client
      let fetched: FetchedDocument
      try {
        fetched = await fetchDocument(new URL(clientId))
      } catch (err) {
        throw new ClientError('invalid_client', `Could not load the client metadata document: ${(err as Error).message}`)
      }
      const client = clientFromMetadataDocument(clientId, fetched.body)
      const seconds = Math.min(
        MAX_CACHE_SECONDS,
        Math.max(MIN_CACHE_SECONDS, fetched.maxAgeSeconds ?? DEFAULT_CACHE_SECONDS),
      )
      if (cache.size > 100) cache.clear()
      cache.set(clientId, { client, expiresAt: now() + seconds * 1000 })
      return client
    },
  }
}
