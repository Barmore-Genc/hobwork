import { createHash, randomBytes, sign } from 'node:crypto'
import type { PushKeys, PushPublicKeys } from './keys.ts'
import { KEY_BYTES, seal, sealedLength } from './seal.ts'

export const DEFAULT_RELAY_URL = 'https://relay.bgenc.dev'
// APNs' limit, which the relay checks on the push it builds.
export const MAX_PAYLOAD_BYTES = 4096
const REQUEST_TIMEOUT_MS = 10_000
// Relay IDs are 16 random bytes in base64url, key IDs 8.
const GRANT_ID_LENGTH = 22
const KEY_ID_LENGTH = 11

// background wakes the app without showing anything (content-available).
export type PushKind = 'alert' | 'command' | 'prompt' | 'background'

// What the app reported in hello: its grant and its X25519 key for this host.
export type PushTarget = { grant: string; key: string }

export type PushMessage = {
  // The notification or command ID, so a push that also reached the app over
  // its socket replaces rather than duplicates it.
  id: string
  kind: PushKind
  payload: { aps: unknown; hobwork: unknown }
  // Unix seconds; 0 for none.
  expiresAt: number
}

export type PushResult =
  | { ok: true }
  // gone: the grant no longer works and should be forgotten.
  | { ok: false; status: number; reason: string; gone: boolean }

// Thrown before anything is sent, so it is not the relay refusing the push.
export class PayloadTooLarge extends Error {
  constructor(size: number) {
    super(`The push is ${size} bytes, and Apple allows ${MAX_PAYLOAD_BYTES}`)
    this.name = 'PayloadTooLarge'
  }
}

// What the app gets at pairing and after every hello.
export type PushInfo = { relay: string } & PushPublicKeys

export type PushSender = {
  info: PushInfo
  send(target: PushTarget, message: PushMessage): Promise<PushResult>
}

// The relay's text for each kind, from relay/src/payload.rs. Only its length matters here.
const FALLBACK_BODY: Record<Exclude<PushKind, 'background'>, string> = {
  alert: 'You have a new notification.',
  command: 'A hob sent a request to this device. Open Hobwork if it did not apply.',
  prompt: 'A hob is waiting. Tap to continue.',
}

export function envelopeSize(kind: PushKind, grant: string, keyId: string, ciphertextBytes: number): number {
  let aps: Record<string, unknown>
  if (kind === 'background') aps = { 'content-available': 1 }
  else {
    aps = { alert: { title: 'Hobwork', body: FALLBACK_BODY[kind] }, 'mutable-content': 1 }
    if (kind === 'command') aps['interruption-level'] = 'passive'
    else aps.sound = 'default'
  }
  const ciphertext = 'A'.repeat(Math.ceil(ciphertextBytes / 3) * 4)
  return Buffer.byteLength(JSON.stringify({ aps, hobwork: { v: 1, grant, keyId, ciphertext } }))
}

function plaintext(message: PushMessage, now: number) {
  return { v: 1, sentAt: Math.floor(now / 1000), expiresAt: message.expiresAt, ...message.payload }
}

// Size of the APNs payload the relay will build. It needs no keys, so a host
// without push still refuses what could not go by push.
export function pushSize(message: PushMessage, now = Date.now(), grant = 'A'.repeat(GRANT_ID_LENGTH), keyId = 'A'.repeat(KEY_ID_LENGTH)): number {
  return envelopeSize(message.kind, grant, keyId, sealedLength(plaintext(message, now)))
}

export function signedMessage(timestamp: string, nonce: string, method: string, path: string, body: string): string {
  const hash = createHash('sha256').update(body).digest('hex')
  return `hobwork-push-v1\n${timestamp}\n${nonce}\n${method}\n${path}\n${hash}`
}

function relayError(body: unknown): { error: string; message: string } {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  return {
    error: typeof value.error === 'string' ? value.error : 'unknown',
    message: typeof value.message === 'string' ? value.message : 'no message',
  }
}

// In-process stand-in for the push sidecar: it holds the keys, seals and signs.
export function createRelayPush(options: {
  url: string
  keys: PushKeys
  fetch?: typeof fetch
  now?: () => number
}): PushSender {
  const { url, keys } = options
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now

  async function send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    const appKey = Buffer.from(target.key, 'base64')
    if (appKey.length !== KEY_BYTES) return { ok: false, status: 0, reason: 'the app sent no usable key', gone: true }
    const sentAt = now()
    const size = pushSize(message, sentAt, target.grant, keys.public.keyId)
    if (size > MAX_PAYLOAD_BYTES) throw new PayloadTooLarge(size)
    const ciphertext = seal({
      plaintext: plaintext(message, sentAt),
      hostKey: keys.encryption,
      hostPublic: keys.encryptionPublic,
      appKey,
      grant: target.grant,
    })
    const body = JSON.stringify({
      kind: message.kind,
      expiration: message.expiresAt,
      collapseId: message.id,
      keyId: keys.public.keyId,
      ciphertext,
    })
    const endpoint = new URL(`/v1/grants/${encodeURIComponent(target.grant)}/push`, url)
    const timestamp = String(Math.floor(sentAt / 1000))
    const nonce = randomBytes(18).toString('base64url')
    const signature = sign(null, Buffer.from(signedMessage(timestamp, nonce, 'POST', endpoint.pathname, body)), keys.signing)
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'hobwork-timestamp': timestamp,
        'hobwork-nonce': nonce,
        'hobwork-signature': signature.toString('base64'),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.ok) {
      await res.body?.cancel()
      return { ok: true }
    }
    const { error, message: text } = relayError(await res.json().catch(() => undefined))
    if (error === 'too_large') throw new PayloadTooLarge(size)
    // An unknown or expired grant is as dead as a gone token: the app makes a new one.
    const gone = error === 'gone' || error === 'expired' || error === 'unknown_grant'
    return { ok: false, status: res.status, reason: `${error}: ${text}`, gone }
  }

  return { info: { relay: url, ...keys.public }, send }
}
