import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, verify, type KeyObject } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inflateRawSync } from 'node:zlib'
import { pushKeysFrom, rawPublicKey, type PushKeys } from './push/keys.ts'
import { signedMessage } from './push/relay.ts'
import type { Push } from './store.ts'

export type RelayRequest = {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  signatureValid: boolean
  // What the app gets after opening the push.
  plaintext: any
}

export function testPushKeys(): PushKeys {
  return pushKeysFrom(generateKeyPairSync('ed25519').privateKey, generateKeyPairSync('x25519').privateKey)
}

// What the app does with a push: X25519 with its own key and the host's.
export function openSealed(options: { ciphertext: string; appKey: KeyObject; hostPublic: Buffer; grant: string }): unknown {
  const appPublic = rawPublicKey(options.appKey)
  const hostKey = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: options.hostPublic.toString('base64url') }, format: 'jwk' })
  const shared = diffieHellman({ privateKey: options.appKey, publicKey: hostKey })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([appPublic, options.hostPublic]), Buffer.from('hobwork-push-v1'), 32))
  const sealed = Buffer.from(options.ciphertext, 'base64')
  const nonce = sealed.subarray(0, 12)
  const tag = sealed.subarray(sealed.length - 16)
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  decipher.setAAD(Buffer.from(options.grant), { plaintextLength: sealed.length - 28 })
  decipher.setAuthTag(tag)
  const framed = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()])
  if (framed.length % 256 !== 0) throw new Error(`The framed plaintext is ${framed.length} bytes, not a multiple of 256`)
  return JSON.parse(inflateRawSync(framed.subarray(4, 4 + framed.readUInt32BE(0))).toString())
}

// A relay that records pushes and opens them as the app would.
export async function startFakeRelay(keys: PushKeys) {
  const received: RelayRequest[] = []
  const appKeys = new Map<string, KeyObject>()
  let answer: (request: RelayRequest) => { status: number; body?: unknown } = () => ({ status: 200, body: { apnsId: 'apns-id' } })
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk))
    req.on('end', () => {
      const path = req.url ?? ''
      const body = JSON.parse(raw) as Record<string, unknown>
      const grant = decodeURIComponent(path.split('/')[3] ?? '')
      const message = signedMessage(
        String(req.headers['hobwork-timestamp']),
        String(req.headers['hobwork-nonce']),
        String(req.method),
        path,
        raw,
      )
      const signatureValid = verify(null, Buffer.from(message), keys.signing, Buffer.from(String(req.headers['hobwork-signature']), 'base64'))
      const appKey = appKeys.get(grant)
      const plaintext = appKey
        ? openSealed({ ciphertext: String(body.ciphertext), appKey, hostPublic: keys.encryptionPublic, grant })
        : undefined
      const request = { path, headers: req.headers, body, signatureValid, plaintext }
      received.push(request)
      const reply = answer(request)
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    answer(next: typeof answer) {
      answer = next
    },
    // A grant the app made for this host, as hello reports it.
    appPush(grant = 'R3JhbnQtZm9yLXRoZS1hcHA'): Push {
      const appKey = generateKeyPairSync('x25519').privateKey
      appKeys.set(grant, appKey)
      return { grant, key: rawPublicKey(appKey).toString('base64') }
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
