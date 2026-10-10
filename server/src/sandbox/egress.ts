import { BlockList, isIP } from 'node:net'
import { isPublicAddress } from '../public-address.ts'

// Same matching as Gondolin's allowlist: `*` matches any run of characters,
// case-insensitively, so `*.example.com` matches subdomains but not example.com.
export function hostMatches(hostname: string, patterns: string[]): boolean {
  const name = hostname.toLowerCase()
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) return false
    if (pattern === '*') return true
    const escaped = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${escaped}$`).test(name)
  })
}

// An `egress` entry of hobwork.json: a host pattern, with a port when only
// that port may be reached. IPv6 addresses with a port are written in brackets.
export type EgressRule = { host: string; port?: number }

function port(text: string): number | undefined {
  const value = Number(text)
  return /^\d{1,5}$/.test(text) && value >= 1 && value <= 65535 ? value : undefined
}

const unbracket = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host)

export function parseEgressEntry(entry: string): EgressRule | undefined {
  const text = entry.trim().toLowerCase()
  if (!text) return undefined
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text)
  if (bracketed) {
    if (bracketed[2] === undefined) return { host: bracketed[1]! }
    const p = port(bracketed[2])
    return p === undefined ? undefined : { host: bracketed[1]!, port: p }
  }
  // A bare IPv6 address has colons of its own.
  if (isIP(text) === 6) return { host: text }
  const colon = text.lastIndexOf(':')
  if (colon === -1) return { host: text }
  const p = port(text.slice(colon + 1))
  const host = text.slice(0, colon)
  return p === undefined || !host || host.includes(':') ? undefined : { host, port: p }
}

export function egressRules(entries: string[]): EgressRule[] {
  return entries.map(parseEgressEntry).filter((rule) => rule !== undefined)
}

// The host patterns alone, for Gondolin's allowlist, which knows no ports.
export function egressHosts(rules: EgressRule[]): string[] {
  return [...new Set(rules.map((rule) => rule.host))]
}

export function egressAllows(rules: EgressRule[], hostname: string, targetPort: number): boolean {
  const name = unbracket(hostname)
  return rules.some((rule) => (rule.port === undefined || rule.port === targetPort) && hostMatches(name, [rule.host]))
}

// HOBWORK_PRIVATE_EGRESS: the private, LAN and tailnet targets hobs may
// reach, set by whoever runs the host. A hob still needs the target in its own
// `egress`. Each entry names a port, so allowing a NAS's web UI does not open
// its SSH or SMB.
export type PrivateEgressRule = { port: number } & ({ host: string } | { network: string; prefix: number })

export class PrivateEgressError extends Error {}

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addSubnet('0.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
LOOPBACK.addAddress('::', 'ipv6')

// The host's own services (Hobwork itself among them) listen on loopback, so
// no setting opens it.
function isLoopback(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return false
  if (LOOPBACK.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  return mapped ? LOOPBACK.check(mapped[1]!, 'ipv4') : false
}

function parsePrivateEntry(entry: string): PrivateEgressRule {
  const example = 'like 100.66.127.125:7912, 192.168.1.0/24:8123, nas.lan:5000 or [fd00::5]:80'
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(entry)
  const colon = entry.lastIndexOf(':')
  const [target, portText] = bracketed ? [bracketed[1]!, bracketed[2]!] : colon === -1 ? [entry, ''] : [entry.slice(0, colon), entry.slice(colon + 1)]
  const p = port(portText)
  if (p === undefined || !target) throw new PrivateEgressError(`"${entry}" needs a host or network and a port, ${example}`)
  const slash = target.indexOf('/')
  if (slash !== -1) {
    const network = target.slice(0, slash)
    const family = isIP(network)
    const prefix = Number(target.slice(slash + 1))
    const max = family === 4 ? 32 : 128
    if (family === 0 || !/^\d+$/.test(target.slice(slash + 1)) || prefix < 1 || prefix > max) {
      throw new PrivateEgressError(`"${entry}" is not a network ${example}`)
    }
    const list = new BlockList()
    list.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6')
    const probe = family === 4 ? '127.0.0.1' : '::1'
    if (list.check(probe, family === 4 ? 'ipv4' : 'ipv6') || isLoopback(network)) {
      throw new PrivateEgressError(`"${entry}" covers loopback addresses, which hobs can never reach`)
    }
    return { network, prefix, port: p }
  }
  if (isIP(target) && isLoopback(target)) throw new PrivateEgressError(`"${entry}" is a loopback address, which hobs can never reach`)
  if (!isIP(target) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(target)) {
    throw new PrivateEgressError(`"${entry}" is not a host name or address ${example}`)
  }
  return { host: target.toLowerCase(), port: p }
}

export function parsePrivateEgress(value: string | undefined): PrivateEgressRule[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parsePrivateEntry)
}

function inNetwork(ip: string, network: string, prefix: number): boolean {
  const family = isIP(ip)
  const networkFamily = isIP(network)
  if (family === 0 || family !== networkFamily) return false
  const list = new BlockList()
  list.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6')
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

// Whether the operator lets hobs connect to `ip` on `port`, reached as `hostname`.
export function privateEgressAllows(rules: PrivateEgressRule[], target: { hostname: string; ip: string; port: number }): boolean {
  const ip = unbracket(target.ip)
  if (isLoopback(ip)) return false
  const hostname = unbracket(target.hostname).toLowerCase()
  return rules.some((rule) =>
    rule.port === target.port && ('host' in rule ? rule.host === hostname || rule.host === ip : inNetwork(ip, rule.network, rule.prefix)))
}

// What a hob's egress entry reaches, for the UI: `private` entries name a
// private address or a host the operator listed, and are reachable only when
// the operator's list covers them.
export function describeEgress(entry: string, rules: PrivateEgressRule[]): { target: string; private: boolean; allowed: boolean } {
  const rule = parseEgressEntry(entry)
  if (!rule) return { target: entry, private: false, allowed: false }
  const ip = isIP(rule.host) ? rule.host : undefined
  const listed = rules.filter((r) => ('host' in r ? r.host === rule.host : ip !== undefined && inNetwork(ip, r.network, r.prefix)))
  const isPrivate = (ip !== undefined && !isPublicAddress(ip)) || listed.length > 0
  if (!isPrivate) return { target: entry, private: false, allowed: true }
  const allowed = !(ip && isLoopback(ip)) && listed.some((r) => rule.port === undefined || r.port === rule.port)
  return { target: entry, private: true, allowed }
}

// The hob log line for a blocked request. `afterCommit` for workspaces, which
// read `egress` from the committed hobwork.json.
export function blockedEgressMessage(event: { hostname: string; ip: string; port: number; private?: boolean }, afterCommit = false): string {
  const where = event.hostname && event.ip && event.hostname !== event.ip ? `${event.hostname} (${event.ip})` : event.hostname || event.ip
  if (event.private) {
    return `Blocked outgoing request to ${where}:${event.port}, a private address. Hobs reach private addresses only when the Hobwork host's HOBWORK_PRIVATE_EGRESS setting lists them with the port, and "egress" in hobwork.json lists them too. Ask the person who runs Hobwork to add it`
  }
  const commit = afterCommit ? ' and commit' : ''
  return `Blocked outgoing request to ${where}:${event.port}. Add the host (or host:port) to "egress" in hobwork.json${commit} to allow it, or assign a secret that may be sent to it`
}
