import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import type { Push, PushEnvironment } from './store.ts'

export const APNS_TOPIC = 'dev.bgenc.hobwork'
export const APNS_ORIGINS: Record<PushEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}
// APNs refuses provider tokens older than an hour and throttles ones renewed
// more often than every 20 minutes.
const JWT_TTL_MS = 40 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
// NAT gateways drop idle connections without telling either side, and a push
// sent on such a connection hangs until it times out.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
export const MAX_PAYLOAD_BYTES = 4096

export type ApnsConfig = { keyFile: string; keyId: string; teamId: string }

export type ApnsMessage = {
  // A UUID. Sent as apns-id and apns-collapse-id, so a notification that also
  // reached the app over its socket replaces rather than duplicates it.
  id: string
  payload: unknown
  // How long APNs keeps trying while the device is offline.
  ttlSeconds?: number
}

export type ApnsResult =
  | { ok: true }
  // tokenGone: the push token no longer works and should be forgotten.
  | { ok: false; status: number; reason: string; tokenGone: boolean }

// Thrown before anything is sent, so it is not Apple refusing the payload.
export class PayloadTooLarge extends Error {
  constructor(size: number) {
    super(`The payload is ${size} bytes, and APNs allows ${MAX_PAYLOAD_BYTES}`)
    this.name = 'PayloadTooLarge'
  }
}

export type Apns = {
  send(push: Push, message: ApnsMessage): Promise<ApnsResult>
  close(): void
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

// ES256 JWT for token-based APNs auth. JWS wants the raw r||s signature, not DER.
export function providerToken(key: KeyObject, keyId: string, teamId: string, now: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `${header}.${claims}.${base64url(signature)}`
}

export function loadApnsKey(keyFile: string): KeyObject {
  let pem: string
  try {
    pem = readFileSync(keyFile, 'utf8')
  } catch (err) {
    throw new Error(`HOBWORK_APNS_KEY_FILE ${keyFile} cannot be read: ${(err as Error).message}`)
  }
  try {
    return createPrivateKey(pem)
  } catch {
    throw new Error(`HOBWORK_APNS_KEY_FILE ${keyFile} is not a .p8 private key from Apple`)
  }
}

export function createApns(options: {
  key: KeyObject
  keyId: string
  teamId: string
  topic?: string
  // Tests point these at a local HTTP/2 server.
  origins?: Record<PushEnvironment, string>
  now?: () => number
  requestTimeoutMs?: number
  idleTimeoutMs?: number
}): Apns {
  const { key, keyId, teamId } = options
  const topic = options.topic ?? APNS_TOPIC
  const origins = options.origins ?? APNS_ORIGINS
  const now = options.now ?? Date.now
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const sessions = new Map<string, ClientHttp2Session>()
  let jwt: { value: string; issuedAt: number } | undefined

  function token(): string {
    if (!jwt || now() - jwt.issuedAt > JWT_TTL_MS) jwt = { value: providerToken(key, keyId, teamId, now()), issuedAt: now() }
    return jwt.value
  }

  // APNs wants one long-lived HTTP/2 connection per origin rather than one per request.
  function session(origin: string): ClientHttp2Session {
    const existing = sessions.get(origin)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const created = connect(origin)
    const forget = () => {
      if (sessions.get(origin) === created) sessions.delete(origin)
    }
    created.on('error', forget)
    created.on('close', forget)
    created.on('goaway', forget)
    created.setTimeout(idleTimeoutMs, () => {
      forget()
      created.close()
    })
    created.unref()
    sessions.set(origin, created)
    return created
  }

  function request(push: Push, message: ApnsMessage, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const origin = origins[push.environment]
      const current = session(origin)
      const stream = current.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(push.token)}`,
        authorization: `bearer ${token()}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-id': message.id,
        'apns-collapse-id': message.id,
        'apns-expiration': String(Math.floor(now() / 1000) + (message.ttlSeconds ?? 24 * 60 * 60)),
        'content-type': 'application/json',
      })
      // A request that gets no answer usually means the connection is dead,
      // so the next one starts a new connection.
      stream.setTimeout(requestTimeoutMs, () => {
        if (sessions.get(origin) === current) sessions.delete(origin)
        current.destroy()
        reject(new Error(`APNs did not answer within ${Math.round(requestTimeoutMs / 1000)}s`))
      })
      let status = 0
      const chunks: Buffer[] = []
      stream.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS])
      })
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
      stream.on('close', () => {
        if (!status) reject(new Error('APNs closed the request without answering'))
      })
      stream.on('error', reject)
      stream.end(body)
    })
  }

  return {
    async send(push, message) {
      const body = JSON.stringify(message.payload)
      if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) throw new PayloadTooLarge(Buffer.byteLength(body))
      // One retry on a new connection when the cached one turns out to be dead.
      // The collapse ID keeps a push that did arrive from showing twice.
      let response = await request(push, message, body).catch(() => request(push, message, body))
      let reason = apnsReason(response.body)
      if (response.status === 403 && reason === 'ExpiredProviderToken') {
        jwt = undefined
        response = await request(push, message, body)
        reason = apnsReason(response.body)
      }
      if (response.status === 200) return { ok: true }
      return {
        ok: false,
        status: response.status,
        reason: reason ?? `HTTP ${response.status}`,
        tokenGone: response.status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic',
      }
    },
    close() {
      for (const s of sessions.values()) s.close()
      sessions.clear()
    },
  }
}

function apnsReason(body: string): string | undefined {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason
    return typeof reason === 'string' ? reason : undefined
  } catch {
    return undefined
  }
}
