import { createCipheriv, createPublicKey, diffieHellman, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

const INFO = Buffer.from('hobwork-push-v1')
const BUCKET = 256
const NONCE_BYTES = 12
const TAG_BYTES = 16
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

export const KEY_BYTES = 32

function x25519Public(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

export function contentKey(hostKey: KeyObject, hostPublic: Buffer, appKey: Buffer): Buffer {
  const shared = diffieHellman({ privateKey: hostKey, publicKey: x25519Public(appKey) })
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([appKey, hostPublic]), INFO, 32))
}

// Pushes of similar size look the same to the relay and Apple.
export function frame(plaintext: unknown): Buffer {
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(plaintext)))
  const framed = Buffer.alloc(Math.ceil((4 + compressed.length) / BUCKET) * BUCKET)
  framed.writeUInt32BE(compressed.length, 0)
  compressed.copy(framed, 4)
  return framed
}

export function sealedLength(plaintext: unknown): number {
  return NONCE_BYTES + frame(plaintext).length + TAG_BYTES
}

// Standard base64 of nonce || ciphertext || tag, CryptoKit's combined sealed box.
export function seal(options: {
  plaintext: unknown
  hostKey: KeyObject
  hostPublic: Buffer
  appKey: Buffer
  grant: string
  nonce?: Buffer
}): string {
  const key = contentKey(options.hostKey, options.hostPublic, options.appKey)
  const nonce = options.nonce ?? randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  const framed = frame(options.plaintext)
  cipher.setAAD(Buffer.from(options.grant), { plaintextLength: framed.length })
  const body = Buffer.concat([cipher.update(framed), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')
}
