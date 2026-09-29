import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

const MAX_BYTES = 16 * 1024
const TIMEOUT_MS = 5000

export type FetchedDocument = { body: unknown; maxAgeSeconds: number | undefined }

// Anyone can make the host fetch a client ID URL, so only public addresses are
// allowed. Checking inside the socket's lookup (not before the request) means a
// DNS answer cannot change between the check and the connection. BlockList
// matches IPv4-mapped IPv6 addresses against the IPv4 rules itself.
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0)
    const allowed = addresses.filter((a) => isPublicAddress(a.address))
    if (allowed.length === 0) {
      return callback(new Error(`${hostname} does not resolve to a public address`), '', 0)
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, allowed)
    callback(null, allowed[0]!.address, allowed[0]!.family)
  })
}

function maxAge(cacheControl: string | undefined): number | undefined {
  if (!cacheControl) return undefined
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/i.test(cacheControl)) return 0
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl)
  return match ? Number(match[1]) : undefined
}

// Fetches a client ID metadata document over HTTPS from a public address,
// without following redirects.
export function fetchMetadataDocument(url: URL): Promise<FetchedDocument> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'https:') return reject(new Error('Client ID URLs must use https'))
    const req = request(
      url,
      { method: 'GET', lookup: publicLookup, headers: { accept: 'application/json' }, timeout: TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`${url.href} answered ${res.statusCode}`))
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BYTES) {
            req.destroy(new Error(`${url.href} is larger than ${MAX_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            resolve({
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              maxAgeSeconds: maxAge(res.headers['cache-control']),
            })
          } catch {
            reject(new Error(`${url.href} is not valid JSON`))
          }
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`${url.href} did not answer within ${TIMEOUT_MS} ms`)))
    req.on('error', reject)
    req.end()
  })
}
