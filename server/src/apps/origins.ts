import { createHash } from 'node:crypto'
import type { Host } from '../host.ts'
import { DEFAULT_BRANCH } from '../projects.ts'
import { listBranches } from '../repo.ts'

// Every project UI has its own origin, so its scripts cannot read another
// project's cookies or call Hobwork's API with the user's session:
//
//   main:    <project>.<apps host>
//   branch:  <branch label>--<project>.<apps host>
//
// Both are one DNS label, so one wildcard certificate covers them all.
// Project names are kebab-case without "--", so the last "--" splits the label.

export type AppTarget = { project: string; branch?: string }

const MAX_LABEL = 63
const HASH_CHARS = 6
const SEPARATOR = '--'
// A branch that is already a DNS label is used as it is. Two-character ones
// would put "--" at positions 3 and 4, which DNS reserves (as in "xn--").
const PLAIN_BRANCH = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MIN_PLAIN = 3

function hashOf(branch: string): string {
  return createHash('sha256').update(branch).digest('hex').slice(0, HASH_CHARS)
}

// The branch's part of its preview label. Branches that are not a lowercase
// DNS label, or too long, get a readable prefix and a hash of the full name,
// so different branches never share a label. Undefined when the project name
// leaves no room.
export function branchLabel(project: string, branch: string): string | undefined {
  const budget = MAX_LABEL - project.length - SEPARATOR.length
  if (PLAIN_BRANCH.test(branch) && branch.length >= MIN_PLAIN && branch.length <= budget) return branch
  const room = budget - HASH_CHARS - 1
  if (budget < HASH_CHARS) return undefined
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, Math.max(room, 0))
    .replace(/^-+|-+$/g, '')
  return slug ? `${slug}-${hashOf(branch)}` : hashOf(branch)
}

export function appLabel(target: AppTarget): string | undefined {
  if (target.branch === undefined || target.branch === DEFAULT_BRANCH) {
    return target.project.length <= MAX_LABEL ? target.project : undefined
  }
  const label = branchLabel(target.project, target.branch)
  return label && `${label}${SEPARATOR}${target.project}`
}

// Splits a label into the project and, for a preview, the branch's label.
export function parseLabel(label: string): { project: string; branchLabel?: string } {
  const at = label.lastIndexOf(SEPARATOR)
  if (at === -1) return { project: label }
  return { project: label.slice(at + SEPARATOR.length), branchLabel: label.slice(0, at) }
}

// Branch names by label for a short while, so a page load with many assets
// lists the repo's branches once.
const RESOLVE_CACHE_MS = 5000

export function createAppOrigins(appsUrl: string) {
  const apps = new URL(appsUrl)
  const domain = apps.hostname
  const cache = new Map<string, { at: number; branches: Map<string, string> }>()

  function origin(target: AppTarget): string | undefined {
    const label = appLabel(target)
    if (!label) return undefined
    const url = new URL(apps.origin)
    url.hostname = `${label}.${domain}`
    return url.origin
  }

  return {
    domain,
    secure: apps.protocol === 'https:',
    origin,

    // The label of a Host header one level below the apps host, or undefined
    // for any other host.
    labelOf(hostHeader: string | undefined): string | undefined {
      if (!hostHeader) return undefined
      let hostname: string
      try {
        hostname = new URL(`http://${hostHeader}`).hostname
      } catch {
        return undefined
      }
      if (!hostname.endsWith(`.${domain}`)) return undefined
      const label = hostname.slice(0, -domain.length - 1)
      return label && !label.includes('.') ? label : undefined
    },

    // The branch whose preview label this is, if it exists.
    async resolveBranch(host: Host, project: string, label: string): Promise<string | undefined> {
      const cached = cache.get(project)
      const fresh = cached && Date.now() - cached.at < RESOLVE_CACHE_MS
      const lookup = (branches: Map<string, string>) => branches.get(label)
      if (fresh && lookup(cached.branches)) return lookup(cached.branches)
      const branches = new Map<string, string>()
      for (const { name } of await listBranches(host, project)) {
        if (name === DEFAULT_BRANCH) continue
        const own = branchLabel(project, name)
        // A plain name wins over a hashed label that happens to match it.
        if (own && (!branches.has(own) || own === name)) branches.set(own, name)
      }
      cache.set(project, { at: Date.now(), branches })
      return lookup(branches)
    },
  }
}

export type AppOrigins = ReturnType<typeof createAppOrigins>
