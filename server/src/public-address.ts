import { networkInterfaces } from 'node:os'
import { BlockList, isIP } from 'node:net'

const RESERVED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

// ::/96 covers the unspecified address, loopback and IPv4-compatible addresses.
// It must not be wider: BlockList matches IPv4 addresses against IPv6 rules as
// IPv4-mapped, so ::/8 would refuse every IPv4 address. The IPv4-mapped range
// (::ffff:0:0/96) is not listed: it is judged by the IPv4 address it carries,
// like NAT64 and 6to4.
const RESERVED_V6: [string, number][] = [
  ['::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]

const reserved = new BlockList()
for (const [net, prefix] of RESERVED_V4) reserved.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of RESERVED_V6) reserved.addSubnet(net, prefix, 'ipv6')

function stripZone(address: string): string {
  return address.split('%')[0]!
}

// Returns the 8 hextets of an IPv6 address, or undefined when it is not one.
export function ipv6Hextets(address: string): number[] | undefined {
  const text = stripZone(address).toLowerCase()
  if (isIP(text) !== 6) return undefined
  const expand = (part: string): number[] => {
    if (!part) return []
    const out: number[] = []
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        const bytes = piece.split('.').map(Number)
        out.push(bytes[0]! * 256 + bytes[1]!, bytes[2]! * 256 + bytes[3]!)
      } else {
        out.push(parseInt(piece, 16))
      }
    }
    return out
  }
  const [head, tail] = text.split('::') as [string, string | undefined]
  const left = expand(head)
  if (tail === undefined) return left
  const right = expand(tail)
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
}

function v4From(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

export type PublicAddressOptions = {
  // Prefixes to refuse on top of the reserved ranges, such as the networks the
  // host's own interfaces are on.
  extraBlocked?: BlockList
}

// True when a guest may connect to the address: not private, reserved or
// local, and not an encoding of such an IPv4 address (IPv4-mapped, NAT64, 6to4).
// NAT64 and 6to4 addresses of public IPv4 hosts pass, since a host on an
// IPv6-only network reaches the internet that way.
export function isPublicAddress(address: string, options: PublicAddressOptions = {}): boolean {
  const text = stripZone(address)
  const family = isIP(text)
  if (family === 0) return false
  if (family === 4) {
    return !reserved.check(text, 'ipv4') && !options.extraBlocked?.check(text, 'ipv4')
  }
  const h = ipv6Hextets(text)
  if (!h || h.length !== 8) return false
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)
  if (mapped || nat64) return isPublicAddress(v4From(h[6]!, h[7]!), options)
  if (h[0] === 0x2002) return isPublicAddress(v4From(h[1]!, h[2]!), options)
  return !reserved.check(text, 'ipv6') && !options.extraBlocked?.check(text, 'ipv6')
}

export function prefixBlockList(prefixes: { address: string, prefix: number }[]): BlockList {
  const list = new BlockList()
  for (const { address, prefix } of prefixes) {
    const family = isIP(address)
    if (family === 0 || prefix === 0) continue
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

// The networks the host itself is on. Global IPv6 prefixes and public IPv4
// subnets of the LAN are otherwise indistinguishable from the internet.
export function hostNetworks(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): { address: string, prefix: number }[] {
  const out: { address: string, prefix: number }[] = []
  for (const addresses of Object.values(interfaces)) {
    for (const a of addresses ?? []) {
      const prefix = Number(a.cidr?.split('/')[1])
      if (Number.isInteger(prefix) && prefix > 0) out.push({ address: stripZone(a.address), prefix })
    }
  }
  return out
}

const HOST_NETWORKS_TTL_MS = 30_000

// Interface addresses change (DHCP, prefix delegation, VPNs), so the list is
// recomputed while the host runs.
export function hostNetworksBlockList(now: () => number = Date.now): () => BlockList {
  let cached: BlockList | undefined
  let at = 0
  return () => {
    if (!cached || now() - at > HOST_NETWORKS_TTL_MS) {
      cached = prefixBlockList(hostNetworks())
      at = now()
    }
    return cached
  }
}
