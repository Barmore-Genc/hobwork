import { isIP } from 'node:net'
import { egressAllows, parseEgressEntry, type EgressRule } from '../sandbox/egress.ts'

const HOST_LIKE = /^(\*|(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/

// `browser.sites` in hobwork.json: the same entries as `egress`, but they name
// the pages a tab opens, not the hosts ctx.fetch reaches. The schema checks
// them too; an entry that is neither a host nor an address is dropped here as
// well, and then it allows nothing.
export function parseBrowserSites(entries: readonly string[] | undefined): EgressRule[] {
  return (entries ?? [])
    .map(parseEgressEntry)
    .filter((rule): rule is EgressRule => rule !== undefined && (HOST_LIKE.test(rule.host) || isIP(unbracket(rule.host)) !== 0))
}

function unbracket(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

// Loopback can never be listed, as in egress: the host's own services listen
// there, and Chrome would reach them with the host's network access.
export function isLoopbackHost(hostname: string): boolean {
  const name = unbracket(hostname)
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (isIP(name) === 0) return false
  return name === '::1' || name === '0.0.0.0' || name === '::' || name.startsWith('127.')
}

// Why a tab may not open `url`, or undefined. Called for every top-level
// navigation, including redirects, script navigations, meta refresh and form
// posts, so a hob cannot leave the sites it declared. Subresources are the
// page's own business and go through untouched.
export function navigationProblem(url: URL, sites: EgressRule[]): string | undefined {
  if (url.protocol !== 'https:') {
    return `Hobwork opens only https pages, not ${JSON.stringify(url.protocol.replace(':', ''))}`
  }
  const hostname = unbracket(url.hostname)
  if (isLoopbackHost(hostname)) return `${hostname} is a loopback address, which hobs can never open`
  const port = url.port ? Number(url.port) : 443
  if (egressAllows(sites, hostname, port)) return undefined
  const where = port === 443 ? hostname : `${hostname}:${port}`
  return `"${where}" is not one of this hob's browser sites. Add it to "browser.sites" in hobwork.json and commit, and a branch preview needs it in the branch's committed hobwork.json too`
}
