import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { AccessError, parseAccess } from '../access.ts'
import { agentNameTaken, freeAgentName, getAgent, MAX_AGENT_NAME } from '../agents.ts'
import type { Auth } from '../auth/auth.ts'
import { HttpError, json, readForm, readJson, redirect } from '../http.ts'
import { ASSERTION_ALGS, assertionSubject, createAssertionVerifier, JWT_BEARER_ASSERTION } from './client-assertion.ts'
import { ClientError, createClientStore, isLoopback, redirectUriAllowed, registerClient, secretMatches, type OAuthClient } from './clients.ts'
import {
  approveRequest,
  consentAgents,
  deleteRequest,
  exchangeCode,
  getRequest,
  OAuthError,
  refreshTokens,
  revokeToken,
  saveRequest,
  verifyAccessToken,
  type AuthorizationRequest,
} from './grants.ts'
import { fetchMetadataDocument, type FetchedDocument } from './metadata-fetch.ts'
import { createRateLimiter, rateLimitKey } from './rate-limit.ts'

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'
const AUTHORIZE_PATH = '/oauth/authorize'
const TOKEN_PATH = '/oauth/token'
const REGISTER_PATH = '/oauth/register'
const REVOKE_PATH = '/oauth/revoke'
// The web UI page that shows consent and authorization errors.
const CONNECT_PAGE = '/connect'

// Per client address. Behind a reverse proxy that is not in
// HOBWORK_TRUSTED_PROXIES every client shares the proxy's address, so these
// are high enough for a household connecting its apps.
const REGISTRATIONS_PER_HOUR = 30
const AUTHORIZATIONS_PER_10_MINUTES = 60

const REQUEST_API = /^\/api\/oauth\/requests\/([A-Za-z0-9_-]+)(\/approve|\/deny)?$/

export type OAuthServer = ReturnType<typeof createOAuthServer>

// RFC 8707 2 and the MCP spec: an absolute URI without a fragment. Scheme and
// host are compared case-insensitively, and a trailing slash is ignored.
export function canonicalResource(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.hash || (url.protocol !== 'https:' && url.protocol !== 'http:')) return undefined
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  return `${url.origin}${path}${url.search}`
}

function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name)
  if (values.length > 1) throw new OAuthError('invalid_request', `${name} is given more than once`)
  return values[0] === '' ? undefined : values[0]
}

function oauthError(res: ServerResponse, err: OAuthError, headers: Record<string, string> = {}) {
  res.writeHead(err.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify({ error: err.code, error_description: err.message }))
}

export function createOAuthServer(options: {
  db: DatabaseSync
  publicUrl: string
  auth: Auth
  mcpPath: string
  clientAddress: (req: IncomingMessage) => string | undefined
  fetchDocument?: (url: URL) => Promise<FetchedDocument>
  now?: () => number
}) {
  const { db, publicUrl, auth } = options
  const now = options.now ?? Date.now
  const clientAddress = (req: IncomingMessage) => rateLimitKey(options.clientAddress(req) ?? 'unknown')
  const issuer = publicUrl
  const resource = `${publicUrl}${options.mcpPath}`
  const resourceMetadataUrl = `${publicUrl}${PROTECTED_RESOURCE_PATH}${options.mcpPath}`
  const fetchDocument = options.fetchDocument ?? fetchMetadataDocument
  const clients = createClientStore({ db, fetchDocument, now })
  const assertions = createAssertionVerifier({ db, fetchDocument, now })
  const registrations = createRateLimiter({ limit: REGISTRATIONS_PER_HOUR, windowMs: 60 * 60 * 1000, now })
  const authorizations = createRateLimiter({ limit: AUTHORIZATIONS_PER_10_MINUTES, windowMs: 10 * 60 * 1000, now })

  const protectedResourceMetadata = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Hobwork',
  }

  const authorizationServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    registration_endpoint: `${issuer}${REGISTER_PATH}`,
    revocation_endpoint: `${issuer}${REVOKE_PATH}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ASSERTION_ALGS,
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
    revocation_endpoint_auth_signing_alg_values_supported: ASSERTION_ALGS,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }

  function redirectWithError(res: ServerResponse, redirectUri: string, state: string | null | undefined, error: string, description: string) {
    const url = new URL(redirectUri)
    url.searchParams.set('error', error)
    url.searchParams.set('error_description', description)
    if (state) url.searchParams.set('state', state)
    url.searchParams.set('iss', issuer)
    redirect(res, url.href)
  }

  async function authorize(req: IncomingMessage, res: ServerResponse, search: URLSearchParams) {
    // Until the client and redirect URI check out, errors go to Hobwork's own
    // page, never to the redirect URI (OAuth 2.1 4.1.2.1).
    const showError = (error: string) => redirect(res, `${CONNECT_PAGE}?error=${error}`)
    // Checked before the client, since looking it up can fetch its metadata document.
    if (authorizations.take(clientAddress(req)) !== undefined) return showError('too_many_requests')
    let clientId: string | undefined
    let redirectUri: string | undefined
    let state: string | undefined
    try {
      clientId = single(search, 'client_id')
      redirectUri = single(search, 'redirect_uri')
      state = single(search, 'state')
    } catch {
      return showError('invalid_request')
    }
    if (!clientId) return showError('invalid_request')
    let client: OAuthClient
    try {
      client = await clients.get(clientId)
    } catch (err) {
      if (!(err instanceof ClientError)) throw err
      console.warn(`OAuth authorization for ${clientId} refused: ${err.message}`)
      return showError('unknown_client')
    }
    if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0]
    if (!redirectUri || !redirectUriAllowed(client, redirectUri)) return showError('invalid_redirect_uri')

    const fail = (error: string, description: string) => redirectWithError(res, redirectUri, state, error, description)
    let request: Omit<AuthorizationRequest, 'id'>
    try {
      if (single(search, 'response_type') !== 'code') {
        return fail('unsupported_response_type', 'Only response_type=code is supported')
      }
      const challenge = single(search, 'code_challenge')
      if (!challenge || single(search, 'code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
        return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required')
      }
      const requested = single(search, 'resource')
      // RFC 8707 allows a default resource when the client names none.
      if (requested !== undefined && canonicalResource(requested) !== resource) {
        return fail('invalid_target', `The only resource here is ${resource}`)
      }
      request = { clientId, redirectUri, state: state ?? null, codeChallenge: challenge, resource, scope: single(search, 'scope') ?? null }
    } catch (err) {
      if (err instanceof OAuthError) return fail(err.code, err.message)
      throw err
    }
    let id: string
    try {
      id = saveRequest(db, request, now())
    } catch (err) {
      if (err instanceof OAuthError && err.status === 429) return showError('too_many_requests')
      throw err
    }
    redirect(res, `${CONNECT_PAGE}?request=${id}`)
  }

  // Authenticates the client at the token and revocation endpoints (OAuth 2.1 2.4).
  async function authenticateClient(req: IncomingMessage, params: URLSearchParams, endpoint: string): Promise<OAuthClient> {
    let id = single(params, 'client_id')
    let secret = single(params, 'client_secret')
    const assertionType = single(params, 'client_assertion_type')
    const assertion = single(params, 'client_assertion')
    if (assertion !== undefined || assertionType !== undefined) {
      if (assertionType !== JWT_BEARER_ASSERTION || !assertion) {
        throw new OAuthError('invalid_client', `Send client_assertion with client_assertion_type ${JWT_BEARER_ASSERTION}`, 401)
      }
      if (secret !== undefined || req.headers.authorization?.startsWith('Basic ')) {
        throw new OAuthError('invalid_request', 'Use one client authentication method')
      }
      id ??= assertionSubject(assertion)
    }
    const header = req.headers.authorization
    const basic = header?.startsWith('Basic ') ?? false
    if (basic) {
      const decoded = Buffer.from(header!.slice('Basic '.length), 'base64').toString('utf8')
      const colon = decoded.indexOf(':')
      try {
        // RFC 6749 2.3.1: both parts are form-urlencoded before base64.
        const headerId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '))
        if (colon === -1 || (id !== undefined && id !== headerId) || secret !== undefined) throw new Error()
        id = headerId
        secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '))
      } catch {
        throw new OAuthError('invalid_client', 'Malformed client credentials', 401)
      }
    }
    const invalid = (message: string) =>
      new OAuthError('invalid_client', message, 401)
    if (!id) throw invalid('Send client_id')
    let client: OAuthClient
    try {
      client = await clients.get(id)
    } catch (err) {
      if (err instanceof ClientError) throw invalid(err.message)
      throw err
    }
    if (client.authMethod === 'private_key_jwt') {
      if (!assertion) throw invalid('This client authenticates with a client_assertion')
      await assertions.verify(client, assertion, [issuer, `${issuer}${endpoint}`])
    } else if (assertion) {
      throw invalid('This client does not authenticate with a client_assertion')
    } else if (client.authMethod !== 'none' && (secret === undefined || !secretMatches(client, secret))) {
      throw invalid('Client authentication failed')
    }
    return client
  }

  function resourceParam(params: URLSearchParams): string | undefined {
    const value = single(params, 'resource')
    if (value === undefined) return undefined
    const canonical = canonicalResource(value)
    if (canonical !== resource) throw new OAuthError('invalid_target', `The only resource here is ${resource}`)
    return canonical
  }

  async function token(req: IncomingMessage, res: ServerResponse) {
    const params = await readForm(req)
    const client = await authenticateClient(req, params, TOKEN_PATH)
    const grantType = single(params, 'grant_type')
    let body
    if (grantType === 'authorization_code') {
      const code = single(params, 'code')
      if (!code) throw new OAuthError('invalid_request', 'Send code')
      body = exchangeCode(db, {
        client,
        code,
        redirectUri: single(params, 'redirect_uri'),
        verifier: single(params, 'code_verifier'),
        resource: resourceParam(params),
        now: now(),
      })
    } else if (grantType === 'refresh_token') {
      const refreshToken = single(params, 'refresh_token')
      if (!refreshToken) throw new OAuthError('invalid_request', 'Send refresh_token')
      body = refreshTokens(db, { client, refreshToken, resource: resourceParam(params), now: now() })
    } else {
      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token')
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' })
    res.end(JSON.stringify(body))
  }

  async function revoke(req: IncomingMessage, res: ServerResponse) {
    const params = await readForm(req)
    const client = await authenticateClient(req, params, REVOKE_PATH)
    const value = single(params, 'token')
    if (!value) throw new OAuthError('invalid_request', 'Send token')
    revokeToken(db, client, value, now())
    res.writeHead(200, { 'cache-control': 'no-store' }).end()
  }

  async function register(req: IncomingMessage, res: ServerResponse) {
    const wait = registrations.take(clientAddress(req))
    if (wait !== undefined) {
      throw new OAuthError('temporarily_unavailable', 'Too many registrations from this address. Try again later.', 429, wait)
    }
    let body: unknown
    try {
      body = await readJson(req, 16 * 1024)
    } catch (err) {
      if (err instanceof HttpError) throw new OAuthError('invalid_client_metadata', err.message, err.status)
      throw err
    }
    try {
      const { client, secret } = registerClient(db, body, now())
      json(res, 201, {
        client_id: client.id,
        client_id_issued_at: Math.floor(now() / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: client.name,
        ...(client.uri ? { client_uri: client.uri } : {}),
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: client.authMethod,
      })
    } catch (err) {
      if (err instanceof ClientError) throw new OAuthError(err.code, err.message)
      throw err
    }
  }

  async function pendingRequest(id: string): Promise<{ request: AuthorizationRequest; client: OAuthClient }> {
    const request = getRequest(db, id, now())
    if (!request) throw new HttpError(404, 'This connection request expired. Start connecting again from the app.')
    try {
      return { request, client: await clients.get(request.clientId) }
    } catch (err) {
      if (err instanceof ClientError) throw new HttpError(404, 'The app that asked for access is no longer known.')
      throw err
    }
  }

  // The consent page's API. It needs a signed-in user like every web UI route.
  async function requestApi(req: IncomingMessage, res: ServerResponse, id: string, action: string | undefined) {
    const method = action ? 'POST' : 'GET'
    if (req.method !== method) {
      res.writeHead(405, { allow: method }).end()
      return
    }
    const user = auth.requireUser(req, res)
    if (!user) return
    const { request, client } = await pendingRequest(id)
    if (!action) {
      return json(res, 200, {
        client: {
          name: client.name,
          uri: client.uri,
          // Metadata document clients prove their domain by hosting the document.
          domain: client.kind === 'metadata-document' ? new URL(client.id).host : null,
        },
        redirectHost: new URL(request.redirectUri).host,
        loopback: isLoopback(request.redirectUri),
        agentName: freeAgentName(db, client.name),
        ...consentAgents(db, client.name),
      })
    }
    if (action === '/deny') {
      deleteRequest(db, id)
      const url = new URL(request.redirectUri)
      url.searchParams.set('error', 'access_denied')
      url.searchParams.set('error_description', 'The user denied access')
      if (request.state) url.searchParams.set('state', request.state)
      url.searchParams.set('iss', issuer)
      return json(res, 200, { redirectTo: url.href })
    }
    const body = (await readJson(req)) as { agentId?: unknown; agentName?: unknown; access?: unknown }
    let agent: { id: number } | { name: string }
    if (body?.agentId !== undefined && body.agentId !== null) {
      if (!Number.isSafeInteger(body.agentId)) throw new HttpError(400, 'agentId must be an agent ID')
      if (!getAgent(db, body.agentId as number)) throw new HttpError(400, 'That agent no longer exists')
      agent = { id: body.agentId as number }
    } else {
      const agentName = typeof body?.agentName === 'string' ? body.agentName.trim() : ''
      if (!agentName) throw new HttpError(400, 'Give the agent a name')
      if (agentName.length > MAX_AGENT_NAME) throw new HttpError(400, `Use at most ${MAX_AGENT_NAME} characters`)
      if (agentNameTaken(db, agentName)) throw new HttpError(409, `An agent called "${agentName}" already exists`)
      agent = { name: agentName }
    }
    let access
    try {
      access = parseAccess(db, body?.access)
    } catch (err) {
      if (err instanceof AccessError) throw new HttpError(400, err.message)
      throw err
    }
    const approved = approveRequest(db, { request, client, agent, access, userId: user.id, now: now() })
    if (!approved) throw new HttpError(404, 'This connection request was already answered.')
    const { code } = approved
    const url = new URL(request.redirectUri)
    url.searchParams.set('code', code)
    if (request.state) url.searchParams.set('state', request.state)
    url.searchParams.set('iss', issuer)
    json(res, 200, { redirectTo: url.href })
  }

  return {
    resource,
    resourceMetadataUrl,

    verifyAccessToken: (value: string) => verifyAccessToken(db, value, resource, now()),

    // Returns false for paths it does not own.
    async handle(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean> {
      const get = req.method === 'GET' || req.method === 'HEAD'
      if (get && (pathname === PROTECTED_RESOURCE_PATH || pathname === `${PROTECTED_RESOURCE_PATH}${options.mcpPath}`)) {
        json(res, 200, protectedResourceMetadata)
        return true
      }
      if (get && pathname === AUTHORIZATION_SERVER_PATH) {
        json(res, 200, authorizationServerMetadata)
        return true
      }
      if (get && pathname === AUTHORIZE_PATH) {
        await authorize(req, res, search)
        return true
      }
      const match = REQUEST_API.exec(pathname)
      if (match) {
        try {
          await requestApi(req, res, match[1]!, match[2])
        } catch (err) {
          if (err instanceof HttpError) json(res, err.status, { error: err.message })
          else throw err
        }
        return true
      }
      const endpoint = { [TOKEN_PATH]: token, [REVOKE_PATH]: revoke, [REGISTER_PATH]: register }[pathname]
      if (!endpoint) return false
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end()
        return true
      }
      try {
        await endpoint(req, res)
      } catch (err) {
        if (err instanceof OAuthError) {
          const headers: Record<string, string> = {}
          if (err.status === 401 && req.headers.authorization?.startsWith('Basic ')) headers['www-authenticate'] = 'Basic realm="Hobwork"'
          if (err.retryAfter !== undefined) headers['retry-after'] = String(err.retryAfter)
          oauthError(res, err, headers)
        } else if (err instanceof HttpError) {
          oauthError(res, new OAuthError('invalid_request', err.message, err.status))
        } else throw err
      }
      return true
    },
  }
}
