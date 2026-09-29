import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { parseTrustedProxies } from '../client-address.ts'
import { addSshKey, generateEd25519KeyPair, listSshKeys } from '../ssh/keys.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'
import { isMetadataDocumentUrl, redirectUriAllowed, type OAuthClient } from './clients.ts'
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './grants.ts'
import { isPublicAddress } from '../public-address.ts'
import type { FetchedDocument } from './metadata-fetch.ts'
import { rateLimitKey } from './rate-limit.ts'
import { canonicalResource } from './routes.ts'
import { s256 } from './secrets.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string
let now: number
let documents: Map<string, unknown>
let fetched: string[]

const CIMD_URL = 'https://claude.example/oauth/claude-code-client-metadata'

beforeEach(async () => {
  host = createTestHost()
  now = Date.now()
  documents = new Map([
    [
      CIMD_URL,
      {
        client_id: CIMD_URL,
        client_name: 'Claude Code',
        client_uri: 'https://claude.example',
        redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    ],
  ])
  fetched = []
  app = await startTestApp(host, {
    selfPublicUrl: true,
    web: {
      now: () => now,
      fetchClientMetadata: async (url: URL): Promise<FetchedDocument> => {
        fetched.push(url.href)
        if (!documents.has(url.href)) throw new Error('404')
        return { body: documents.get(url.href), maxAgeSeconds: undefined }
      },
    },
  })
  cookie = signedIn(host).cookie
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

const mcpUrl = () => `${app.base}/mcp`

async function jsonOf(res: Response): Promise<any> {
  return res.json()
}

function form(path: string, params: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(`${app.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  })
}

function mcpRequest(token?: string) {
  return fetch(mcpUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

// What the browser does: follow /oauth/authorize to the consent page, then
// approve or deny as the signed-in user. Returns where the browser ends up.
async function consent(
  authorizationUrl: string,
  answer: 'approve' | 'deny' = 'approve',
  agentName?: string,
  access?: { readOnly: boolean; projects: string[] | null },
) {
  const res = await fetch(authorizationUrl, { redirect: 'manual' })
  expect(res.status).toBe(303)
  const location = new URL(res.headers.get('location')!, app.base)
  expect(location.pathname).toBe('/connect')
  const id = location.searchParams.get('request')
  expect(id).toBeTruthy()
  const info = await jsonOf(await fetch(`${app.base}/api/oauth/requests/${id}`, { headers: { cookie } }))
  const answered = await fetch(`${app.base}/api/oauth/requests/${id}/${answer}`, {
    method: 'POST',
    headers: writeHeaders(cookie, app.base),
    body: JSON.stringify({ agentName: agentName ?? info.agentName, access }),
  })
  expect(answered.status).toBe(200)
  return { info, redirectTo: new URL((await jsonOf(answered)).redirectTo) }
}

class TestProvider implements OAuthClientProvider {
  redirectUrl: string
  clientMetadataUrl: string | undefined
  info: OAuthClientInformationMixed | undefined
  savedTokens: OAuthTokens | undefined
  verifier = ''
  authorizationUrl: URL | undefined

  constructor(options: { redirectUrl: string; clientMetadataUrl?: string }) {
    this.redirectUrl = options.redirectUrl
    this.clientMetadataUrl = options.clientMetadataUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Test Connector',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  clientInformation() {
    return this.info
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info
  }
  tokens() {
    return this.savedTokens
  }
  saveTokens(tokens: OAuthTokens) {
    this.savedTokens = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }
}

// Runs the whole flow with the MCP SDK client: 401, discovery, registration
// (or a metadata document), consent, code exchange, and a tool call.
async function connectWithOAuth(provider: TestProvider) {
  const transport = () => new StreamableHTTPClientTransport(new URL(mcpUrl()), { authProvider: provider })
  const first = new Client({ name: 'test', version: '0.0.0' })
  const pending = transport()
  await expect(first.connect(pending)).rejects.toBeInstanceOf(UnauthorizedError)
  expect(provider.authorizationUrl).toBeDefined()
  const { info, redirectTo } = await consent(provider.authorizationUrl!.href)
  expect(redirectTo.searchParams.get('iss')).toBe(app.base)
  await pending.finishAuth(redirectTo.searchParams.get('code')!)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(transport())
  return { client, info }
}

// A client registered through the API with a fixed redirect URI, for the
// token endpoint tests.
async function registeredClient(extra: Record<string, unknown> = {}) {
  const res = await fetch(`${app.base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Manual',
      redirect_uris: ['https://app.example/callback'],
      token_endpoint_auth_method: 'none',
      ...extra,
    }),
  })
  expect(res.status).toBe(201)
  return (await jsonOf(res)) as { client_id: string; client_secret?: string }
}

function authorizeUrl(clientId: string, params: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(`${app.base}/oauth/authorize`)
  const all: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://app.example/callback',
    code_challenge: s256(verifier),
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: mcpUrl(),
    ...params,
  }
  for (const [key, value] of Object.entries(all)) url.searchParams.set(key, value)
  return { url: url.href, verifier }
}

async function tokensFor(
  clientId: string,
  access?: { readOnly: boolean; projects: string[] | null },
): Promise<{ access_token: string; refresh_token: string }> {
  const { url, verifier } = authorizeUrl(clientId)
  const { redirectTo } = await consent(url, 'approve', undefined, access)
  const res = await form('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: redirectTo.searchParams.get('code')!,
    redirect_uri: 'https://app.example/callback',
    code_verifier: verifier,
    resource: mcpUrl(),
  })
  expect(res.status).toBe(200)
  return jsonOf(res)
}

test('metadata points MCP clients at the authorization server', async () => {
  const unauthorized = await mcpRequest()
  expect(unauthorized.status).toBe(401)
  const challenge = unauthorized.headers.get('www-authenticate')!
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
  expect(metadataUrl).toBe(`${app.base}/.well-known/oauth-protected-resource/mcp`)

  const resource = await jsonOf(await fetch(metadataUrl!))
  expect(resource).toMatchObject({ resource: mcpUrl(), authorization_servers: [app.base] })
  expect(await jsonOf(await fetch(`${app.base}/.well-known/oauth-protected-resource`))).toEqual(resource)

  const server = await jsonOf(await fetch(`${app.base}/.well-known/oauth-authorization-server`))
  expect(server).toMatchObject({
    issuer: app.base,
    authorization_endpoint: `${app.base}/oauth/authorize`,
    token_endpoint: `${app.base}/oauth/token`,
    registration_endpoint: `${app.base}/oauth/register`,
    revocation_endpoint: `${app.base}/oauth/revoke`,
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  })
  expect(server.token_endpoint_auth_methods_supported).toContain('none')

  const invalid = await mcpRequest('hwa_not-a-token')
  expect(invalid.status).toBe(401)
  expect(invalid.headers.get('www-authenticate')).toContain('error="invalid_token"')
})

test('an MCP client registers, gets consent, and calls tools with its access token', async () => {
  const provider = new TestProvider({ redirectUrl: 'http://127.0.0.1:43123/callback' })
  const { client, info } = await connectWithOAuth(provider)
  expect(info).toMatchObject({
    client: { name: 'Test Connector', domain: null },
    redirectHost: '127.0.0.1:43123',
    loopback: true,
    agentName: 'Test Connector',
  })
  const result = await client.callTool({ name: 'list_hobs', arguments: {} })
  expect(result.isError).toBeFalsy()
  await client.close()

  const agents = await jsonOf(await fetch(`${app.base}/api/agents`, { headers: { cookie } }))
  expect(agents).toMatchObject([
    {
      name: 'Test Connector',
      tokens: [],
      connections: [{ clientName: 'Test Connector', redirectHost: '127.0.0.1:43123', connectedBy: 'Kaan', revokedAt: null }],
    },
  ])
  expect(agents[0].connections[0].lastUsedAt).not.toBeNull()
})

test('a client with a metadata document connects without registering', async () => {
  const provider = new TestProvider({ redirectUrl: 'http://localhost:51234/callback', clientMetadataUrl: CIMD_URL })
  const { client, info } = await connectWithOAuth(provider)
  expect(provider.info?.client_id).toBe(CIMD_URL)
  expect(fetched).toEqual([CIMD_URL])
  expect(info).toMatchObject({ client: { name: 'Claude Code', domain: 'claude.example' }, loopback: true })
  expect((await client.callTool({ name: 'list_hobs', arguments: {} })).isError).toBeFalsy()
  await client.close()
  expect(host.db.prepare('SELECT count(*) AS n FROM oauth_clients').get()?.n).toBe(0)
})

test('the user can rename the agent and a second connection gets its own agent', async () => {
  const { client_id } = await registeredClient()
  const { url } = authorizeUrl(client_id)
  await consent(url, 'approve', 'Claude on the phone')
  const second = await consent(authorizeUrl(client_id).url)
  expect(second.info.agentName).toBe('Manual')
  const third = await consent(authorizeUrl(client_id).url)
  expect(third.info.agentName).toBe('Manual 2')

  const { url: taken } = authorizeUrl(client_id)
  const res = await fetch(taken, { redirect: 'manual' })
  const id = new URL(res.headers.get('location')!, app.base).searchParams.get('request')
  const conflict = await fetch(`${app.base}/api/oauth/requests/${id}/approve`, {
    method: 'POST',
    headers: writeHeaders(cookie, app.base),
    body: JSON.stringify({ agentName: 'Claude on the phone' }),
  })
  expect(conflict.status).toBe(409)
  const names = (await jsonOf(await fetch(`${app.base}/api/agents`, { headers: { cookie } }))).map((a: any) => a.name)
  expect(names).toEqual(['Claude on the phone', 'Manual', 'Manual 2'])
})

test('consent needs a signed-in user and the CSRF header', async () => {
  const { client_id } = await registeredClient()
  const res = await fetch(authorizeUrl(client_id).url, { redirect: 'manual' })
  const id = new URL(res.headers.get('location')!, app.base).searchParams.get('request')
  expect((await fetch(`${app.base}/api/oauth/requests/${id}`)).status).toBe(401)
  const noCsrf = await fetch(`${app.base}/api/oauth/requests/${id}/approve`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ agentName: 'x' }),
  })
  expect(noCsrf.status).toBe(403)
  expect((await fetch(`${app.base}/api/oauth/requests/unknown`, { headers: { cookie } })).status).toBe(404)
})

test('denying sends access_denied back to the client', async () => {
  const { client_id } = await registeredClient()
  const { redirectTo } = await consent(authorizeUrl(client_id).url, 'deny')
  expect(redirectTo.origin + redirectTo.pathname).toBe('https://app.example/callback')
  expect(Object.fromEntries(redirectTo.searchParams)).toMatchObject({ error: 'access_denied', state: 'xyz', iss: app.base })
  expect(host.db.prepare('SELECT count(*) AS n FROM agents').get()?.n).toBe(0)
})

test('authorization errors never redirect to an unregistered URI', async () => {
  const { client_id } = await registeredClient()
  const cases: [Record<string, string>, string][] = [
    [{ redirect_uri: 'https://evil.example/callback' }, '/connect?error=invalid_redirect_uri'],
    [{ client_id: 'hwc_unknown' }, '/connect?error=unknown_client'],
    [{ client_id: 'https://nowhere.example/meta.json' }, '/connect?error=unknown_client'],
  ]
  for (const [params, location] of cases) {
    const res = await fetch(authorizeUrl(client_id, params).url, { redirect: 'manual' })
    expect(res.headers.get('location')).toBe(location)
  }

  const errors: [Record<string, string>, string][] = [
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
  ]
  for (const [params, error] of errors) {
    const res = await fetch(authorizeUrl(client_id, params).url, { redirect: 'manual' })
    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe('https://app.example')
    expect(location.searchParams.get('error')).toBe(error)
    expect(location.searchParams.get('state')).toBe('xyz')
  }
})

test('the code exchange checks PKCE, redirect URI, resource, and single use', async () => {
  const { client_id } = await registeredClient()
  const exchange = async (overrides: Record<string, string> = {}) => {
    const { url, verifier } = authorizeUrl(client_id)
    const { redirectTo } = await consent(url)
    const params = {
      grant_type: 'authorization_code',
      client_id,
      code: redirectTo.searchParams.get('code')!,
      redirect_uri: 'https://app.example/callback',
      code_verifier: verifier,
      resource: mcpUrl(),
      ...overrides,
    }
    return { res: await form('/oauth/token', params), params }
  }

  expect(await jsonOf((await exchange({ code_verifier: 'wrong'.repeat(10) })).res)).toMatchObject({ error: 'invalid_grant' })
  expect(await jsonOf((await exchange({ redirect_uri: 'https://app.example/other' })).res)).toMatchObject({ error: 'invalid_grant' })
  expect(await jsonOf((await exchange({ resource: 'https://other.example/mcp' })).res)).toMatchObject({ error: 'invalid_target' })
  const other = await registeredClient()
  expect(await jsonOf((await exchange({ client_id: other.client_id })).res)).toMatchObject({ error: 'invalid_grant' })

  const { res, params } = await exchange()
  const tokens = await jsonOf(res)
  expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS })
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect((await mcpRequest(tokens.access_token)).status).toBe(200)

  // A second use of the code revokes what the first one issued.
  expect(await jsonOf(await form('/oauth/token', params))).toMatchObject({ error: 'invalid_grant' })
  expect((await mcpRequest(tokens.access_token)).status).toBe(401)
})

test('refresh tokens rotate, and reusing one revokes the connection', async () => {
  const { client_id } = await registeredClient()
  const first = await tokensFor(client_id)
  const refresh = (token: string) => form('/oauth/token', { grant_type: 'refresh_token', client_id, refresh_token: token })

  const second = await jsonOf(await refresh(first.refresh_token))
  expect(second.refresh_token).not.toBe(first.refresh_token)
  expect(second.access_token).not.toBe(first.access_token)
  expect((await mcpRequest(second.access_token)).status).toBe(200)

  const reused = await refresh(first.refresh_token)
  expect(reused.status).toBe(400)
  expect(await jsonOf(reused)).toMatchObject({ error: 'invalid_grant' })
  expect((await mcpRequest(second.access_token)).status).toBe(401)
  expect(await jsonOf(await refresh(second.refresh_token))).toMatchObject({ error: 'invalid_grant' })
  const agents = await jsonOf(await fetch(`${app.base}/api/agents`, { headers: { cookie } }))
  expect(agents[0].connections[0].revokedAt).not.toBeNull()
})

test('tokens expire', async () => {
  const { client_id } = await registeredClient()
  const tokens = await tokensFor(client_id)
  now += ACCESS_TOKEN_TTL_SECONDS * 1000 + 1
  expect((await mcpRequest(tokens.access_token)).status).toBe(401)
  const refreshed = await jsonOf(
    await form('/oauth/token', { grant_type: 'refresh_token', client_id, refresh_token: tokens.refresh_token }),
  )
  expect((await mcpRequest(refreshed.access_token)).status).toBe(200)
  now += REFRESH_TOKEN_TTL_SECONDS * 1000 + 1
  expect(
    await jsonOf(await form('/oauth/token', { grant_type: 'refresh_token', client_id, refresh_token: refreshed.refresh_token })),
  ).toMatchObject({ error: 'invalid_grant' })

  const { url, verifier } = authorizeUrl(client_id)
  const { redirectTo } = await consent(url)
  now += 6 * 60 * 1000
  const late = await form('/oauth/token', {
    grant_type: 'authorization_code',
    client_id,
    code: redirectTo.searchParams.get('code')!,
    redirect_uri: 'https://app.example/callback',
    code_verifier: verifier,
  })
  expect(await jsonOf(late)).toMatchObject({ error: 'invalid_grant' })
})

test('a token issued for another resource is refused', async () => {
  const { client_id } = await registeredClient()
  const tokens = await tokensFor(client_id)
  host.db.prepare(`UPDATE oauth_grants SET resource = 'https://other.example/mcp'`).run()
  expect((await mcpRequest(tokens.access_token)).status).toBe(401)
  expect(
    await jsonOf(
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        client_id,
        refresh_token: tokens.refresh_token,
        resource: mcpUrl(),
      }),
    ),
  ).toMatchObject({ error: 'invalid_target' })
})

test('clients revoke their tokens', async () => {
  const { client_id } = await registeredClient()
  const tokens = await tokensFor(client_id)
  const other = await registeredClient()
  expect((await form('/oauth/revoke', { client_id: other.client_id, token: tokens.access_token })).status).toBe(200)
  expect((await mcpRequest(tokens.access_token)).status).toBe(200)

  expect((await form('/oauth/revoke', { client_id, token: tokens.access_token })).status).toBe(200)
  expect((await mcpRequest(tokens.access_token)).status).toBe(401)
  const refreshed = await jsonOf(
    await form('/oauth/token', { grant_type: 'refresh_token', client_id, refresh_token: tokens.refresh_token }),
  )
  expect((await mcpRequest(refreshed.access_token)).status).toBe(200)

  expect((await form('/oauth/revoke', { client_id, token: refreshed.refresh_token, token_type_hint: 'refresh_token' })).status).toBe(200)
  expect((await mcpRequest(refreshed.access_token)).status).toBe(401)
  expect((await form('/oauth/revoke', { client_id, token: 'unknown' })).status).toBe(200)
})

test('revoking a connection in the web UI ends its tokens and SSH keys, static keys keep working', async () => {
  const { client_id } = await registeredClient()
  const tokens = await tokensFor(client_id)
  const { token: staticToken } = createAgentToken(host.db, 'claude-code')
  const agents = await jsonOf(await fetch(`${app.base}/api/agents`, { headers: { cookie } }))
  const manual = agents.find((a: any) => a.name === 'Manual')
  const connection = manual.connections[0]
  const credential = { kind: 'grant', id: connection.id } as const
  const sshKey = addSshKey(host.db, manual.id, 'laptop', generateEd25519KeyPair().public, { via: 'agent', credential })
  expect(sshKey.addedFrom).toEqual({ via: 'agent', token: null, signIn: { id: connection.id, clientName: connection.clientName } })

  const res = await fetch(`${app.base}/api/connections/${connection.id}/revoke`, {
    method: 'POST',
    headers: writeHeaders(cookie, app.base),
  })
  expect(res.status).toBe(204)
  expect((await mcpRequest(tokens.access_token)).status).toBe(401)
  expect(
    await jsonOf(await form('/oauth/token', { grant_type: 'refresh_token', client_id, refresh_token: tokens.refresh_token })),
  ).toMatchObject({ error: 'invalid_grant' })
  expect((await mcpRequest(staticToken)).status).toBe(200)
  expect(listSshKeys(host.db, manual.id)[0]?.revokedAt).not.toBeNull()
})

test('confidential clients must authenticate', async () => {
  const { client_id, client_secret } = await registeredClient({ token_endpoint_auth_method: 'client_secret_basic' })
  expect(client_secret).toBeTruthy()
  const { url, verifier } = authorizeUrl(client_id)
  const { redirectTo } = await consent(url)
  const params = {
    grant_type: 'authorization_code',
    code: redirectTo.searchParams.get('code')!,
    redirect_uri: 'https://app.example/callback',
    code_verifier: verifier,
  }
  const unauthenticated = await form('/oauth/token', { ...params, client_id })
  expect(unauthenticated.status).toBe(401)
  const wrong = await form('/oauth/token', params, {
    authorization: `Basic ${Buffer.from(`${client_id}:nope`).toString('base64')}`,
  })
  expect(wrong.status).toBe(401)
  expect(wrong.headers.get('www-authenticate')).toContain('Basic')
  const ok = await form('/oauth/token', params, {
    authorization: `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`,
  })
  expect(ok.status).toBe(200)
})

test('registration only accepts https and loopback redirect URIs', async () => {
  const register = (body: unknown) =>
    fetch(`${app.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  for (const redirect of ['http://app.example/cb', 'myapp://cb', 'https://app.example/cb#x', 'not a url']) {
    const res = await register({ redirect_uris: [redirect] })
    expect(res.status).toBe(400)
    expect(await jsonOf(res)).toMatchObject({ error: 'invalid_redirect_uri' })
  }
  expect(await jsonOf(await register({ redirect_uris: ['https://a.example/cb'], grant_types: ['client_credentials'] }))).toMatchObject({
    error: 'invalid_client_metadata',
  })
  const extraGrant = await register({
    redirect_uris: ['https://a.example/cb'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
    token_endpoint_auth_method: 'none',
  })
  expect(await jsonOf(extraGrant)).toMatchObject({ grant_types: ['authorization_code', 'refresh_token'] })
  const ok = await jsonOf(await register({ redirect_uris: ['http://127.0.0.1:1234/cb'], token_endpoint_auth_method: 'none' }))
  expect(ok).toMatchObject({ client_name: '127.0.0.1:1234', token_endpoint_auth_method: 'none' })
  expect(ok.client_secret).toBeUndefined()
})

test("Claude's metadata document with extra grant types is accepted", async () => {
  const url = 'https://claude.example/oauth/mcp-oauth-client-metadata'
  documents.set(url, {
    client_id: url,
    client_name: 'Claude',
    client_uri: 'https://claude.example',
    redirect_uris: ['https://claude.example/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
  const { info, redirectTo } = await consent(authorizeUrl(url, { redirect_uri: 'https://claude.example/api/mcp/auth_callback' }).url)
  expect(info).toMatchObject({ client: { name: 'Claude', domain: 'claude.example' }, loopback: false })
  expect(redirectTo.searchParams.get('code')).toBeTruthy()
})

test('metadata documents are validated', async () => {
  const bad: [string, unknown][] = [
    ['https://c.example/a', { client_id: 'https://c.example/other', client_name: 'A', redirect_uris: ['https://c.example/cb'] }],
    ['https://c.example/b', { client_id: 'https://c.example/b', redirect_uris: ['https://c.example/cb'] }],
    ['https://c.example/c', { client_id: 'https://c.example/c', client_name: 'C', redirect_uris: ['https://c.example/cb'], token_endpoint_auth_method: 'client_secret_basic' }],
    ['https://c.example/d', { client_id: 'https://c.example/d', client_name: 'D', redirect_uris: ['http://c.example/cb'] }],
  ]
  for (const [url, document] of bad) {
    documents.set(url, document)
    const res = await fetch(authorizeUrl(url, { redirect_uri: 'https://c.example/cb' }).url, { redirect: 'manual' })
    expect(res.headers.get('location')).toBe('/connect?error=unknown_client')
  }
})

test('redirect URIs match exactly, loopback ones on any port', () => {
  const client: OAuthClient = {
    id: 'x',
    name: 'x',
    uri: null,
    redirectUris: ['http://localhost/callback', 'http://127.0.0.1:8000/cb', 'https://app.example/cb'],
    authMethod: 'none',
    kind: 'registered',
    secretHash: null,
  }
  expect(redirectUriAllowed(client, 'http://localhost:3118/callback')).toBe(true)
  expect(redirectUriAllowed(client, 'http://127.0.0.1:9/cb')).toBe(true)
  expect(redirectUriAllowed(client, 'http://localhost:3118/other')).toBe(false)
  expect(redirectUriAllowed(client, 'http://localhost.evil.example/callback')).toBe(false)
  expect(redirectUriAllowed(client, 'https://app.example/cb')).toBe(true)
  expect(redirectUriAllowed(client, 'https://app.example:444/cb')).toBe(false)
  expect(redirectUriAllowed(client, 'https://app.example/cb?x=1')).toBe(false)
})

test('helpers', () => {
  expect(canonicalResource('HTTP://Hob.Example:80/mcp/')).toBe('http://hob.example/mcp')
  expect(canonicalResource('https://hob.example/mcp#x')).toBeUndefined()
  expect(isMetadataDocumentUrl('https://claude.ai/oauth/meta')).toBe(true)
  expect(isMetadataDocumentUrl('https://claude.ai/')).toBe(false)
  expect(isMetadataDocumentUrl('http://claude.ai/meta')).toBe(false)
  expect(isMetadataDocumentUrl('hwc_abc')).toBe(false)
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    expect(isPublicAddress(address)).toBe(false)
  }
  for (const address of [
    '64:ff9b::7f00:1',
    '64:ff9b:1::a00:1',
    '64:ff9b:1:ffff::1',
    '2002:7f00:1::1',
    '2002:c0a8:101::',
    '::7f00:1',
    '::8.8.8.8',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ]) {
    expect(isPublicAddress(address), address).toBe(false)
  }
  expect(isPublicAddress('160.79.104.10')).toBe(true)
  expect(isPublicAddress('2606:4700::1')).toBe(true)
})

function mcpClient(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  return { client, connect: () => client.connect(transport) }
}

test('the consent page limits a connection to some projects and to reading', async () => {
  for (const name of ['filament', 'garden', 'sleep']) host.db.prepare('INSERT INTO projects (name) VALUES (?)').run(name)
  const { client_id } = await registeredClient()
  const { access_token } = await tokensFor(client_id, { readOnly: true, projects: ['garden', 'filament'] })
  const { client, connect } = mcpClient(access_token)
  await connect()
  const names = (await client.listTools()).tools.map((tool) => tool.name)
  expect(names).toContain('read_file')
  expect(names).not.toContain('write_file')
  expect(names).not.toContain('create_hob')
  const listed = await client.callTool({ name: 'list_hobs', arguments: {} })
  expect(JSON.parse((listed.content as { text: string }[])[0]!.text).map((p: { name: string }) => p.name)).toEqual([
    'filament',
    'garden',
  ])
  const other = await client.callTool({ name: 'list_versions', arguments: { hob: 'sleep' } })
  expect(other.isError).toBe(true)
  expect(JSON.stringify(other.content)).toContain('no access to the hob \\"sleep\\"')
  await client.close()

  const [agent] = await jsonOf(await fetch(`${app.base}/api/agents`, { headers: { cookie } }))
  expect(agent.connections[0].access).toEqual({ readOnly: true, projects: ['filament', 'garden'] })
})

test('approving with an unknown project or no project is refused', async () => {
  const { client_id } = await registeredClient()
  for (const [projects, error] of [
    [['nope'], 'Hob "nope" does not exist'],
    [[], 'Choose at least one hob'],
  ] as const) {
    const res = await fetch(authorizeUrl(client_id).url, { redirect: 'manual' })
    const id = new URL(res.headers.get('location')!, app.base).searchParams.get('request')
    const answered = await fetch(`${app.base}/api/oauth/requests/${id}/approve`, {
      method: 'POST',
      headers: writeHeaders(cookie, app.base),
      body: JSON.stringify({ agentName: 'Limited', access: { readOnly: false, projects } }),
    })
    expect(answered.status).toBe(400)
    expect((await jsonOf(answered)).error).toBe(error)
  }
  expect(host.db.prepare('SELECT count(*) AS n FROM oauth_grants').get()?.n).toBe(0)
})

test('registration is rate limited per address and the oldest unused clients make room', async () => {
  const register = () =>
    fetch(`${app.base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://app.example/callback'], token_endpoint_auth_method: 'none' }),
    })
  for (let i = 0; i < 30; i++) expect((await register()).status).toBe(201)
  const limited = await register()
  expect(limited.status).toBe(429)
  expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  expect((await jsonOf(limited)).error).toBe('temporarily_unavailable')

  now += 60 * 60 * 1000
  const insert = host.db.prepare(
    `INSERT INTO oauth_clients (id, name, redirect_uris, auth_method, created_at) VALUES (?, 'x', '[]', 'none', ?)`,
  )
  for (let i = 0; i < 200 - 30; i++) insert.run(`hwc_filler${i}`, new Date(now - 3 * 60 * 60 * 1000 - 1000 * (200 - i)).toISOString())
  const count = () => Number(host.db.prepare('SELECT count(*) AS n FROM oauth_clients').get()?.n)
  expect(count()).toBe(200)
  const full = await register()
  expect(full.status).toBe(201)
  expect(count()).toBe(200)
  const registered = ((await jsonOf(full)) as { client_id: string }).client_id
  expect(host.db.prepare('SELECT 1 FROM oauth_clients WHERE id = ?').get(registered)).toBeTruthy()
  expect(host.db.prepare(`SELECT 1 FROM oauth_clients WHERE id = 'hwc_filler0'`).get()).toBeUndefined()
})

test('behind a trusted proxy the limits apply to each forwarded client', async () => {
  await app.close()
  app = await startTestApp(host, { selfPublicUrl: true, web: { now: () => now, trustedProxies: parseTrustedProxies('127.0.0.1') } })
  const register = (forwardedFor: string) =>
    fetch(`${app.base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ redirect_uris: ['https://app.example/callback'], token_endpoint_auth_method: 'none' }),
    })
  for (let i = 0; i < 30; i++) expect((await register('198.51.100.1')).status).toBe(201)
  expect((await register('198.51.100.1')).status).toBe(429)
  expect((await register('203.0.113.9, 198.51.100.1')).status).toBe(429)
  expect((await register('198.51.100.2')).status).toBe(201)
  expect((await register('198.51.100.1, 198.51.100.2')).status).toBe(201)
})

test('without trusted proxies a forwarded address does not escape the limit', async () => {
  const register = (forwardedFor: string) =>
    fetch(`${app.base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ redirect_uris: ['https://app.example/callback'], token_endpoint_auth_method: 'none' }),
    })
  for (let i = 0; i < 30; i++) expect((await register(`198.51.100.${i}`)).status).toBe(201)
  expect((await register('198.51.100.200')).status).toBe(429)
})

test('authorization requests are rate limited per address and the oldest pending ones make room', async () => {
  const { client_id } = await registeredClient()
  const location = async () =>
    new URL((await fetch(authorizeUrl(client_id).url, { redirect: 'manual' })).headers.get('location')!, app.base)
  for (let i = 0; i < 60; i++) expect((await location()).searchParams.get('request')).toBeTruthy()
  expect((await location()).search).toBe('?error=too_many_requests')

  now += 10 * 60 * 1000
  const insert = host.db.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, resource, expires_at) VALUES (?, 'x', 'x', 'x', 'x', ?)`,
  )
  for (let i = 0; i < 200; i++) insert.run(`filler${i}`, new Date(now + 60_000 + i * 1000).toISOString())
  expect((await location()).searchParams.get('request')).toBeTruthy()
  const count = () => Number(host.db.prepare('SELECT count(*) AS n FROM oauth_requests').get()?.n)
  expect(count()).toBe(200)
  expect(host.db.prepare(`SELECT 1 FROM oauth_requests WHERE id = 'filler0'`).get()).toBeUndefined()
  expect(host.db.prepare(`SELECT 1 FROM oauth_requests WHERE id = 'filler199'`).get()).toBeTruthy()
})

test('IPv6 clients are limited by their /64', () => {
  expect(rateLimitKey('203.0.113.9')).toBe('203.0.113.9')
  expect(rateLimitKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
  expect(rateLimitKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
  expect(rateLimitKey('2001:0DB8:1:2:0:0:0:9')).toBe('2001:db8:1:2::/64')
  expect(rateLimitKey('2001:db8:1:3::1')).not.toBe(rateLimitKey('2001:db8:1:2::1'))
  expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  expect(rateLimitKey('::1')).toBe('0:0:0:0::/64')
  expect(rateLimitKey('unknown')).toBe('unknown')
})
