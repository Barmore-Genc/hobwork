import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import * as client from 'openid-client'
import type { Allowlist, OidcConfig } from '../config.ts'
import { parseCookies, redirect, setCookie } from '../http.ts'
import type { Auth } from './auth.ts'
import { signInOidcUser, type OidcIdentity } from './users.ts'

export const LOGIN_PATH = '/auth/login'
export const CALLBACK_PATH = '/auth/callback'

const FLOW_COOKIE = 'hobwork_oidc'
const FLOW_COOKIE_PATH = '/auth/'
const FLOW_TTL_SECONDS = 10 * 60

type Flow = { state: string; nonce: string; verifier: string; returnTo: string }

// Where the sign-in page sends people back to after an error.
export type LoginError = 'not_allowed' | 'failed' | 'expired'

// Only same-origin paths, so the login flow cannot be used as an open redirect.
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  return value
}

function encodeFlow(flow: Flow): string {
  return Buffer.from(JSON.stringify(flow)).toString('base64url')
}

function decodeFlow(value: string | undefined): Flow | undefined {
  if (!value) return undefined
  try {
    const flow = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Flow>
    if (typeof flow.state !== 'string' || typeof flow.nonce !== 'string' || typeof flow.verifier !== 'string') {
      return undefined
    }
    return { state: flow.state, nonce: flow.nonce, verifier: flow.verifier, returnTo: safeReturnTo(flow.returnTo) }
  } catch {
    return undefined
  }
}

function claimString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function identityFromClaims(issuer: string, claims: Record<string, unknown>): OidcIdentity {
  const subject = claimString(claims, 'sub')
  if (!subject) throw new Error('ID token has no subject')
  const email = claims.email_verified === true ? (claimString(claims, 'email') ?? null) : null
  const name =
    claimString(claims, 'name') ??
    [claimString(claims, 'given_name'), claimString(claims, 'family_name')].filter(Boolean).join(' ')
  return {
    issuer,
    subject,
    email,
    name: name || claimString(claims, 'preferred_username') || email || 'Unnamed',
  }
}

export function createOidcLogin(options: {
  oidc: OidcConfig
  publicUrl: string
  db: DatabaseSync
  allowlist: Allowlist
  auth: Auth
}) {
  const { oidc, publicUrl, db, allowlist, auth } = options
  const redirectUri = `${publicUrl}${CALLBACK_PATH}`
  let discovered: Promise<client.Configuration> | undefined

  // Discovered on first use and cached, so the host starts while the provider is down.
  function configuration(): Promise<client.Configuration> {
    discovered ??= client
      .discovery(
        new URL(oidc.issuer),
        oidc.clientId,
        undefined,
        oidc.clientSecret ? client.ClientSecretBasic(oidc.clientSecret) : client.None(),
        // Plain http is only for a provider on the local network or in development.
        oidc.issuer.startsWith('http:') ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((err: unknown) => {
        discovered = undefined
        throw err
      })
    return discovered
  }

  function fail(res: ServerResponse, error: LoginError) {
    setCookie(res, FLOW_COOKIE, '', { maxAge: 0, secure: auth.secure, path: FLOW_COOKIE_PATH })
    redirect(res, `/login?error=${error}`)
  }

  async function login(res: ServerResponse, search: URLSearchParams) {
    let config: client.Configuration
    try {
      config = await configuration()
    } catch (err) {
      console.error('OIDC discovery failed', err)
      return fail(res, 'failed')
    }
    const flow: Flow = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier: client.randomPKCECodeVerifier(),
      returnTo: safeReturnTo(search.get('returnTo')),
    }
    setCookie(res, FLOW_COOKIE, encodeFlow(flow), {
      maxAge: FLOW_TTL_SECONDS,
      secure: auth.secure,
      path: FLOW_COOKIE_PATH,
    })
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: 'S256',
    })
    redirect(res, url.href)
  }

  async function callback(req: IncomingMessage, res: ServerResponse) {
    const flow = decodeFlow(parseCookies(req.headers.cookie).get(FLOW_COOKIE))
    if (!flow) return fail(res, 'expired')
    let identity: OidcIdentity
    try {
      const config = await configuration()
      const tokens = await client.authorizationCodeGrant(config, new URL(req.url ?? '/', publicUrl), {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      })
      let claims: Record<string, unknown> = { ...tokens.claims() }
      if (claims.email === undefined) {
        claims = { ...(await client.fetchUserInfo(config, tokens.access_token, String(claims.sub))), ...claims }
      }
      identity = identityFromClaims(config.serverMetadata().issuer, claims)
    } catch (err) {
      console.error('OIDC sign-in failed', err)
      return fail(res, 'failed')
    }
    const user = signInOidcUser(db, allowlist, identity)
    if (!user) {
      console.warn(
        `Refused sign-in for ${identity.email ?? 'an unverified email'} (subject ${identity.subject}): not in HOBWORK_ALLOWED_USERS`,
      )
      return fail(res, 'not_allowed')
    }
    setCookie(res, FLOW_COOKIE, '', { maxAge: 0, secure: auth.secure, path: FLOW_COOKIE_PATH })
    auth.signIn(res, user)
    redirect(res, flow.returnTo)
  }

  return { name: oidc.name, login, callback }
}

export type OidcLogin = ReturnType<typeof createOidcLogin>
