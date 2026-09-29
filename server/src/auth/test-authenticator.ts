import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

// A software passkey for tests: an ES256 key pair behind the registration and
// authentication responses a browser would return for a discoverable credential.

const UP = 0x01
const UV = 0x04
const AT = 0x40

function b64url(value: Uint8Array | string): string {
  return Buffer.from(value).toString('base64url')
}

function sha256(value: Uint8Array | string): Buffer {
  return createHash('sha256').update(value).digest()
}

type Options = { challenge: string; rp?: { id?: string }; rpId?: string; user?: { id: string } }

export class SoftwareAuthenticator {
  credentialId = randomBytes(16)
  privateKey: KeyObject
  publicJwk: { x: string; y: string }
  userHandle: string | undefined
  counter = 0
  origin: string

  constructor(origin: string) {
    this.origin = origin
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' })
    this.publicJwk = { x: jwk.x!, y: jwk.y! }
  }

  private clientData(type: string, challenge: string): string {
    return JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false })
  }

  private authData(rpId: string, flags: number, attested?: Buffer): Buffer {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, ...(attested ? [attested] : [])])
  }

  register(options: Options) {
    const rpId = options.rp!.id!
    this.userHandle = options.user!.id
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(this.publicJwk.x, 'base64url')],
        [-3, Buffer.from(this.publicJwk.y, 'base64url')],
      ]),
    )
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, Buffer.from(cose)])
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, string> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', this.authData(rpId, UP | UV | AT, attested)],
      ]),
    )
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    }
  }

  authenticate(options: Options) {
    this.counter++
    const clientDataJSON = this.clientData('webauthn.get', options.challenge)
    const authenticatorData = this.authData(options.rpId!, UP | UV)
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey)
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    }
  }
}
