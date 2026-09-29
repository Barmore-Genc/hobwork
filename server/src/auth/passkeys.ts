import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { Allowlist } from '../config.ts'
import { HttpError, json, readJson } from '../http.ts'
import type { Auth } from './auth.ts'
import { MAX_PASSKEY_NAME, passkeyName } from './passkey-names.ts'
import { getUser, isAllowed, markSignedIn, webauthnUserId, type User } from './users.ts'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
// EdDSA, ES256 and RS256. The library's default list probes Node for ML-DSA
// support, which prints an experimental feature warning.
const ALGORITHMS = [-8, -7, -257]

const SIGN_IN_OPTIONS_PATH = '/auth/passkey/options'
const SIGN_IN_PATH = '/auth/passkey'
const PASSKEYS_PATH = '/api/passkeys'
const REGISTER_OPTIONS_PATH = '/api/passkeys/options'
const PASSKEY_PATH = /^\/api\/passkeys\/(\d+)$/

export type Passkey = { id: number; name: string; createdAt: string; lastUsedAt: string | null }

type StoredPasskey = {
  id: number
  userId: number
  credentialId: string
  publicKey: Uint8Array<ArrayBuffer>
  counter: number
  transports: AuthenticatorTransport[]
}

const iso = (ms: number) => new Date(ms).toISOString()

// Challenges live in the DB, never in the browser, so each one is accepted once.
function saveChallenge(db: DatabaseSync, challenge: string, userId: number | null, now: number): string {
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(iso(now))
  const id = randomBytes(18).toString('base64url')
  db.prepare('INSERT INTO webauthn_challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    challenge,
    userId,
    iso(now + CHALLENGE_TTL_MS),
  )
  return id
}

function takeChallenge(db: DatabaseSync, id: unknown, userId: number | null, now: number): string {
  if (typeof id !== 'string') throw new HttpError(400, 'Send the flowId from the options request')
  const row = db
    .prepare('DELETE FROM webauthn_challenges WHERE id = ? AND expires_at > ? AND user_id IS ? RETURNING challenge')
    .get(id, iso(now), userId)
  if (!row) throw new HttpError(400, 'This passkey request expired. Try again.')
  return String(row.challenge)
}

function toPasskey(row: Record<string, unknown>): Passkey {
  return {
    id: Number(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
  }
}

export function listPasskeys(db: DatabaseSync, userId: number): Passkey[] {
  return db
    .prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map(toPasskey)
}

function storedPasskey(row: Record<string, unknown>): StoredPasskey {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    credentialId: String(row.credential_id),
    publicKey: Uint8Array.from(row.public_key as Uint8Array),
    counter: Number(row.counter),
    transports: JSON.parse(String(row.transports)) as AuthenticatorTransport[],
  }
}

function credentialsOf(db: DatabaseSync, userId: number): StoredPasskey[] {
  return db.prepare('SELECT * FROM passkeys WHERE user_id = ?').all(userId).map(storedPasskey)
}

function body<T>(value: unknown): Partial<T> {
  return typeof value === 'object' && value !== null ? (value as Partial<T>) : {}
}

export function createPasskeys(options: {
  db: DatabaseSync
  publicUrl: string
  allowlist: Allowlist
  auth: Auth
  now?: () => number
}) {
  const { db, publicUrl, allowlist, auth } = options
  const now = options.now ?? Date.now
  // The RP ID is the host name, so passkeys keep working when only the port or
  // scheme of HOBWORK_PUBLIC_URL changes.
  const rpID = new URL(publicUrl).hostname

  async function registrationOptions(user: User) {
    const options = await generateRegistrationOptions({
      rpName: 'Hobwork',
      rpID,
      userName: user.email ?? user.name,
      userDisplayName: user.name,
      userID: Buffer.from(webauthnUserId(db, user.id), 'base64url'),
      attestationType: 'none',
      excludeCredentials: credentialsOf(db, user.id).map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: ALGORITHMS,
    })
    return { flowId: saveChallenge(db, options.challenge, user.id, now()), options }
  }

  async function register(user: User, input: unknown): Promise<Passkey> {
    const { flowId, response, name, device } = body<{
      flowId: string
      response: RegistrationResponseJSON
      name: string
      device: string
    }>(input)
    const challenge = takeChallenge(db, flowId, user.id, now())
    if (typeof response !== 'object' || response === null) throw new HttpError(400, 'Send the passkey response')
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: publicUrl,
        expectedRPID: rpID,
        supportedAlgorithmIDs: ALGORITHMS,
      })
    } catch (err) {
      throw new HttpError(400, `The passkey could not be verified: ${(err as Error).message}`)
    }
    if (!verification.verified) throw new HttpError(400, 'The passkey could not be verified')
    const { credential, aaguid } = verification.registrationInfo
    const label = passkeyName({ name, aaguid, device })
    const row = db
      .prepare(
        `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (credential_id) DO NOTHING
         RETURNING id, name, created_at, last_used_at`,
      )
      .get(user.id, credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), label)
    if (!row) throw new HttpError(409, 'This passkey is already registered')
    return toPasskey(row)
  }

  function rename(user: User, id: number, input: unknown): Passkey {
    const { name } = body<{ name: string }>(input)
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) throw new HttpError(400, 'Give the passkey a name')
    if (trimmed.length > MAX_PASSKEY_NAME) throw new HttpError(400, `Keep the name to ${MAX_PASSKEY_NAME} characters`)
    const row = db
      .prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ? RETURNING id, name, created_at, last_used_at')
      .get(trimmed, id, user.id)
    if (!row) throw new HttpError(404, 'This passkey does not exist')
    return toPasskey(row)
  }

  async function signInOptions() {
    // No allowCredentials: the browser offers every discoverable passkey for
    // this site, so nobody has to type a user name first.
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' })
    return { flowId: saveChallenge(db, options.challenge, null, now()), options }
  }

  // Returns the user, or throws an HttpError with a message for the sign-in page.
  async function signIn(input: unknown): Promise<User> {
    const { flowId, response } = body<{ flowId: string; response: AuthenticationResponseJSON }>(input)
    const challenge = takeChallenge(db, flowId, null, now())
    if (typeof response !== 'object' || response === null || typeof response.id !== 'string') {
      throw new HttpError(400, 'Send the passkey response')
    }
    const row = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(response.id)
    if (!row) throw new HttpError(401, 'Hobwork does not know this passkey. Sign in another way and add it in Settings.')
    const passkey = storedPasskey(row)
    const user = getUser(db, passkey.userId)
    if (!user) throw new HttpError(401, 'Hobwork does not know this passkey')
    const handle = response.response?.userHandle
    if (handle && handle !== webauthnUserId(db, user.id)) throw new HttpError(401, 'This passkey belongs to someone else')
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: publicUrl,
        expectedRPID: rpID,
        credential: { id: passkey.credentialId, publicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports },
      })
    } catch (err) {
      throw new HttpError(401, `The passkey could not be verified: ${(err as Error).message}`)
    }
    if (!verification.verified) throw new HttpError(401, 'The passkey could not be verified')
    if (!isAllowed(db, allowlist, user)) {
      throw new HttpError(403, 'This account is not on the list of people who can use Hobwork.')
    }
    db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(
      verification.authenticationInfo.newCounter,
      iso(now()),
      passkey.id,
    )
    markSignedIn(db, user.id)
    return user
  }

  async function route(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (pathname === SIGN_IN_OPTIONS_PATH && req.method === 'POST') {
      if (!auth.checkCsrf(req, res)) return true
      json(res, 200, await signInOptions())
      return true
    }
    if (pathname === SIGN_IN_PATH && req.method === 'POST') {
      if (!auth.checkCsrf(req, res)) return true
      const user = await signIn(await readJson(req))
      auth.signIn(res, user)
      json(res, 200, { user: { name: user.name, email: user.email } })
      return true
    }
    const match = PASSKEY_PATH.exec(pathname)
    const known =
      (pathname === PASSKEYS_PATH && (req.method === 'GET' || req.method === 'POST')) ||
      (pathname === REGISTER_OPTIONS_PATH && req.method === 'POST') ||
      (match && (req.method === 'DELETE' || req.method === 'PATCH'))
    if (!known) {
      if (pathname === PASSKEYS_PATH || pathname === REGISTER_OPTIONS_PATH || match) {
        res.writeHead(405).end()
        return true
      }
      return false
    }
    const user = auth.requireUser(req, res)
    if (!user) return true
    if (pathname === REGISTER_OPTIONS_PATH) json(res, 200, await registrationOptions(user))
    else if (match && req.method === 'PATCH') json(res, 200, rename(user, Number(match[1]), await readJson(req)))
    else if (match) {
      const result = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(Number(match[1]), user.id)
      if (Number(result.changes) === 0) throw new HttpError(404, 'This passkey does not exist')
      res.writeHead(204).end()
    } else if (req.method === 'GET') json(res, 200, listPasskeys(db, user.id))
    else json(res, 201, await register(user, await readJson(req)))
    return true
  }

  return {
    rpID,
    // Returns false for paths it does not own.
    async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
      try {
        return await route(req, res, pathname)
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
        json(res, err.status, { error: err.message })
        return true
      }
    },
  }
}

export type Passkeys = ReturnType<typeof createPasskeys>
