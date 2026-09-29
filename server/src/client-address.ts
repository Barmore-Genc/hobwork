import type { IncomingMessage } from 'node:http'
import { BlockList, isIP, isIPv4 } from 'node:net'

export type TrustedProxies = BlockList

// The URL parser gives IPv6 addresses one spelling, so a client cannot get a
// fresh rate limit key by writing its address differently.
function canonicalIPv6(address: string): string | undefined {
  try {
    return new URL(`http://[${address}]`).hostname.slice(1, -1)
  } catch {
    return undefined
  }
}

// ::ffff:127.0.0.1 is how a dual-stack socket reports an IPv4 client.
function unmapped(address: string): string | undefined {
  if (isIPv4(address)) return address
  const canonical = canonicalIPv6(address)
  const mapped = canonical && /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!mapped) return canonical
  const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)]
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

// An address from a socket or a proxy header: a bare IP, an IPv4 address with
// a port, or a bracketed IPv6 address with an optional port.
export function normalizeAddress(value: string): string | undefined {
  let address = value.trim()
  const withPort = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(address) ?? /^([\d.]+):(\d{1,5})$/.exec(address)
  if (withPort) {
    if (Number(withPort[2] ?? 0) > 65535) return undefined
    address = withPort[1]!
  }
  if (!isIP(address)) return undefined
  return unmapped(address)
}

export function parseTrustedProxies(value: string | undefined): TrustedProxies {
  const list = new BlockList()
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    const invalid = new Error(
      `HOBWORK_TRUSTED_PROXIES must be a comma-separated list of IP addresses and CIDR ranges like 10.0.0.0/8 or fd00::/8, got "${entry}"`,
    )
    const slash = entry.indexOf('/')
    const written = slash === -1 ? entry : entry.slice(0, slash)
    const address = isIP(written) ? unmapped(written) : undefined
    if (!address) throw invalid
    const family = isIPv4(address) ? 'ipv4' : 'ipv6'
    if (slash === -1) {
      list.addAddress(address, family)
      continue
    }
    const prefixText = entry.slice(slash + 1)
    let prefix = Number(prefixText)
    if (!/^\d{1,3}$/.test(prefixText) || prefix > (isIP(written) === 4 ? 32 : 128)) throw invalid
    // A mapped range like ::ffff:10.0.0.0/104 is written as IPv6 but means 10.0.0.0/8.
    if (family === 'ipv4' && isIP(written) === 6) {
      if (prefix < 96) throw invalid
      prefix -= 96
    }
    list.addSubnet(address, prefix, family)
  }
  return list
}

function isTrusted(trusted: TrustedProxies, address: string): boolean {
  return trusted.check(address, isIPv4(address) ? 'ipv4' : 'ipv6')
}

// Behind trusted proxies the client is the rightmost X-Forwarded-For entry that
// no trusted proxy added: everything left of it came from the client and can be
// made up. Without trusted proxies the header is ignored, since anyone can send it.
export function clientAddress(req: IncomingMessage, trusted: TrustedProxies): string | undefined {
  const raw = req.socket.remoteAddress
  if (raw === undefined) return undefined
  const socket = normalizeAddress(raw)
  if (socket === undefined) return raw
  if (!isTrusted(trusted, socket)) return socket
  const header = req.headers['x-forwarded-for']
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header]
  const chain = values.flatMap((value) => value.split(',')).filter((entry) => entry.trim() !== '')
  let leftmost: string | undefined
  for (let i = chain.length - 1; i >= 0; i--) {
    const address = normalizeAddress(chain[i]!)
    if (address === undefined) return socket
    if (!isTrusted(trusted, address)) return address
    leftmost = address
  }
  return leftmost ?? socket
}
