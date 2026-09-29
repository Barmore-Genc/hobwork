import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

// A minimal OpenID provider for tests: discovery, JWKS, token endpoint with
// client_secret_basic and PKCE, and userinfo. Authorization is not a web page;
// tests call approve() with the authorization URL the host redirected to.
export type FakeOidcProvider = Awaited<ReturnType<typeof startFakeOidcProvider>>

type Grant = { clientId: string; redirectUri: string; nonce: string; challenge: string; claims: Record<string, unknown> }

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export async function startFakeOidcProvider(client: { id: string; secret: string }) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
  const grants = new Map<string, Grant>()
  const accessTokens = new Map<string, Record<string, unknown>>()
  let issuer = ''
  const tokenRequests: URLSearchParams[] = []
  let omitIdTokenProfile = false

  function idToken(grant: Grant): string {
    const now = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }))
    const profile = omitIdTokenProfile ? { sub: grant.claims.sub } : grant.claims
    const payload = base64url(
      JSON.stringify({ iss: issuer, aud: grant.clientId, iat: now, exp: now + 300, nonce: grant.nonce, ...profile }),
    )
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey)
    return `${header}.${payload}.${base64url(signature)}`
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer)
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      })
    }
    if (url.pathname === '/jwks') return send(200, { keys: [jwk] })
    if (url.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req))
      tokenRequests.push(params)
      // RFC 6749 2.3.1: both parts are form-urlencoded before base64.
      const [id, secret] = Buffer.from(req.headers.authorization?.replace(/^Basic /, '') ?? '', 'base64')
        .toString('utf8')
        .split(':')
        .map((part) => decodeURIComponent(part))
      if (id !== client.id || secret !== client.secret) return send(401, { error: 'invalid_client' })
      const code = params.get('code') ?? ''
      const grant = grants.get(code)
      grants.delete(code)
      if (!grant || params.get('grant_type') !== 'authorization_code') return send(400, { error: 'invalid_grant' })
      if (params.get('redirect_uri') !== grant.redirectUri) return send(400, { error: 'invalid_grant' })
      const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url')
      if (challenge !== grant.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE' })
      const accessToken = randomBytes(16).toString('hex')
      accessTokens.set(accessToken, grant.claims)
      return send(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken(grant) })
    }
    if (url.pathname === '/userinfo') {
      const claims = accessTokens.get(req.headers.authorization?.replace(/^Bearer /, '') ?? '')
      return claims ? send(200, claims) : send(401, { error: 'invalid_token' })
    }
    send(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    get issuer() {
      return issuer
    },
    tokenRequests,
    // Only the subject goes into the ID token, so the host has to call userinfo.
    set omitIdTokenProfile(value: boolean) {
      omitIdTokenProfile = value
    },
    // Signs the user in at the provider and returns the URL the provider
    // redirects the browser back to.
    approve(authorizationUrl: string, claims: Record<string, unknown>): string {
      const request = new URL(authorizationUrl)
      if (request.origin !== issuer) throw new Error(`Authorization URL ${authorizationUrl} is not for this provider`)
      const q = request.searchParams
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') {
        throw new Error(`Unexpected authorization request ${authorizationUrl}`)
      }
      const code = randomBytes(16).toString('hex')
      grants.set(code, {
        clientId: q.get('client_id') ?? '',
        redirectUri: q.get('redirect_uri') ?? '',
        nonce: q.get('nonce') ?? '',
        challenge: q.get('code_challenge') ?? '',
        claims,
      })
      const back = new URL(q.get('redirect_uri') ?? '')
      back.searchParams.set('code', code)
      back.searchParams.set('state', q.get('state') ?? '')
      back.searchParams.set('iss', issuer)
      return back.href
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
