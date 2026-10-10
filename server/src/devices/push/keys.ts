import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type PushPublicKeys = { signingKey: string; encryptionKey: string; keyId: string }

export type PushKeys = {
  signing: KeyObject
  encryption: KeyObject
  encryptionPublic: Buffer
  public: PushPublicKeys
}

const FILE = 'keys.json'

export function rawPublicKey(key: KeyObject): Buffer {
  const jwk = createPublicKey(key).export({ format: 'jwk' })
  return Buffer.from(jwk.x!, 'base64url')
}

export function keyIdOf(encryptionPublic: Buffer): string {
  return createHash('sha256').update(encryptionPublic).digest().subarray(0, 8).toString('base64url')
}

export function pushKeysFrom(signing: KeyObject, encryption: KeyObject): PushKeys {
  const encryptionPublic = rawPublicKey(encryption)
  return {
    signing,
    encryption,
    encryptionPublic,
    public: {
      signingKey: rawPublicKey(signing).toString('base64'),
      encryptionKey: encryptionPublic.toString('base64'),
      keyId: keyIdOf(encryptionPublic),
    },
  }
}

// The keys live outside the data dir so backups never hold them. A restored
// host without them makes new ones, and apps grant those on their next hello.
export function loadPushKeys(dir: string): PushKeys {
  const path = join(dir, FILE)
  let stored: { signing: JsonWebKey; encryption: JsonWebKey } | undefined
  try {
    stored = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Push keys in ${path} cannot be read: ${(err as Error).message}`)
    }
  }
  if (stored) {
    return pushKeysFrom(createPrivateKey({ key: stored.signing, format: 'jwk' }), createPrivateKey({ key: stored.encryption, format: 'jwk' }))
  }
  const signing = generateKeyPairSync('ed25519').privateKey
  const encryption = generateKeyPairSync('x25519').privateKey
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const json = JSON.stringify({ signing: signing.export({ format: 'jwk' }), encryption: encryption.export({ format: 'jwk' }) })
  writeFileSync(`${path}.tmp`, json, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
  return pushKeysFrom(signing, encryption)
}
