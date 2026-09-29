import { createHash, randomBytes } from 'node:crypto'

// Every secret is 256 random bits, so an unsalted hash is enough to make a
// leaked DB useless.
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function newSecret(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}
