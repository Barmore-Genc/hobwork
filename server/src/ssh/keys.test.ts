import ssh2 from 'ssh2'
import { expect, test } from 'vitest'
import { generateEd25519KeyPair, parsePublicKey } from './keys.ts'

test('generated Ed25519 pairs always parse, including public keys that start with a zero byte', () => {
  for (let i = 0; i < 3000; i++) {
    const pair = generateEd25519KeyPair()
    const parsedPublic = parsePublicKey(pair.public)
    expect(parsedPublic.algorithm).toBe('ssh-ed25519')
    expect(Buffer.from(parsedPublic.keyData, 'base64')).toHaveLength(51)
    const parsedPrivate = ssh2.utils.parseKey(pair.private)
    expect(parsedPrivate).not.toBeInstanceOf(Error)
    expect((parsedPrivate as ssh2.ParsedKey).getPublicSSH().toString('base64')).toBe(parsedPublic.keyData)
  }
})
