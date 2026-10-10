import { parseHobworkJson } from '../../../packages/sdk/src/hobwork-json.js'
import { filePathProblem, MAX_FILE_BYTES } from '../../../packages/sdk/src/runner/protocol.ts'
import { DEFAULT_UPLOAD_BYTES } from '../../../packages/sdk/src/uploads.ts'
import { git, GitError } from '../git.ts'
import { repoPath, type Host } from '../host.ts'
import type { TriggerEntry } from '../homeassistant/triggers.ts'
import { ProjectError } from '../projects.ts'
import type { ResourceRequest } from '../sandbox/budget.ts'
import type { CspSources } from './csp.ts'
import type { CronEntry } from './scheduler.ts'
import type { StaticMount } from './files.ts'
import type { InvocationKind } from './logs.ts'

export type Entry = { handler: string }

// An `uploads` entry: files go under `prefix` (ending in "/").
export type UploadEntry = { prefix: string; maxBytes: number; types: string[] }

export type IntentParameter = { id: string; title: string; type: 'text' | 'number' | 'boolean'; optional: boolean }

// An entry of `intents`: runs route, or only opens the app at open.
export type IntentEntry = {
  id: string
  title: string
  route?: string
  method: string
  parameters: IntentParameter[]
  opensApp: boolean
  open?: string
}

// An entry of `share`: a target in the app's share sheet. Files go into the
// upload `upload`, then `route` runs (POST) with a ShareRequest.
export type ShareEntry = {
  id: string
  title: string
  route: string
  accepts: { urls: boolean; text: boolean; files: string[] }
  upload?: string
}

// Paths of the hob's origin that open the app as universal links, in the
// syntax of apple-app-site-association components.
export type AppLinks = { include?: string[]; exclude: string[] }

export type ProjectConfig = {
  routes: Record<string, Entry>
  crons: Record<string, Entry & CronEntry>
  webhooks: Record<string, Entry>
  triggers: Record<string, Entry & TriggerEntry>
  egress: string[]
  csp: CspSources
  crossAppRequests: string[]
  // Longest prefix first.
  static: StaticMount[]
  uploads: Record<string, UploadEntry>
  idleTimeoutMs: number
  resources: ResourceRequest
  // The GET route of the hob's widget.
  widget?: string
  intents: IntentEntry[]
  share: ShareEntry[]
  appLinks: AppLinks
}

export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000
// setTimeout runs its callback immediately for delays above 2^31-1.
export const MAX_IDLE_TIMEOUT_MS = 2 ** 31 - 1

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text)
  if (!match) throw new ProjectError(`"${text}" is not a duration like 30s, 15m or 1h`)
  return Number(match[1]) * UNITS[match[2]!]!
}

// Paths on the app origin that are not the UI's.
const RESERVED_PREFIXES = new Set(['api', '_hobwork', 'theme'])

// The schema checks these too, but an entry that would serve anything else is
// dropped here as well, like CSP sources.
function staticMounts(entries: Record<string, { dir?: unknown; public?: unknown }> | undefined): StaticMount[] {
  return Object.entries(entries ?? {})
    .filter(([prefix, entry]) => {
      const path = prefix.slice(1)
      return prefix.startsWith('/') && !filePathProblem(path) && !RESERVED_PREFIXES.has(path.split('/')[0]!) && !filePathProblem(entry.dir)
    })
    .map(([prefix, entry]) => ({ prefix, dir: entry.dir as string, public: entry.public === true }))
    .sort((a, b) => b.prefix.length - a.prefix.length)
}

// Like static mounts, an entry that would write anywhere else is dropped.
function uploadEntries(entries: Record<string, { prefix?: unknown; maxBytes?: unknown; types?: unknown }> | undefined): Record<string, UploadEntry> {
  const out: Record<string, UploadEntry> = {}
  for (const [name, entry] of Object.entries(entries ?? {})) {
    const prefix = entry.prefix
    if (typeof prefix !== 'string' || !prefix.endsWith('/') || filePathProblem(prefix.slice(0, -1))) continue
    const max = typeof entry.maxBytes === 'number' && Number.isInteger(entry.maxBytes) && entry.maxBytes > 0 ? entry.maxBytes : DEFAULT_UPLOAD_BYTES
    const types = Array.isArray(entry.types) ? entry.types.filter((t): t is string => typeof t === 'string') : []
    out[name] = { prefix, maxBytes: Math.min(max, MAX_FILE_BYTES), types }
  }
  return out
}

function intentEntries(entries: unknown): IntentEntry[] {
  if (!Array.isArray(entries)) return []
  return entries.map((raw: Record<string, unknown>) => ({
    id: String(raw.id),
    title: String(raw.title),
    ...(typeof raw.route === 'string' ? { route: raw.route } : {}),
    method: typeof raw.method === 'string' ? raw.method : 'POST',
    parameters: (Array.isArray(raw.parameters) ? raw.parameters : []).map((p: Record<string, unknown>) => ({
      id: String(p.id),
      title: String(p.title),
      type: p.type === 'number' || p.type === 'boolean' ? p.type : 'text',
      optional: p.optional === true,
    })),
    opensApp: raw.opensApp === true,
    ...(typeof raw.open === 'string' ? { open: raw.open } : {}),
  }))
}

function shareEntries(entries: unknown): ShareEntry[] {
  if (!Array.isArray(entries)) return []
  return entries.map((raw: Record<string, unknown>) => {
    const accepts = (typeof raw.accepts === 'object' && raw.accepts !== null ? raw.accepts : {}) as Record<string, unknown>
    return {
      id: String(raw.id),
      title: String(raw.title),
      route: String(raw.route),
      accepts: {
        urls: accepts.urls === true,
        text: accepts.text === true,
        files: Array.isArray(accepts.files) ? accepts.files.filter((t): t is string => typeof t === 'string') : [],
      },
      ...(typeof raw.upload === 'string' ? { upload: raw.upload } : {}),
    }
  })
}

function paths(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string' && p.startsWith('/')) : undefined
}

function appLinks(value: unknown): AppLinks {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const include = paths(raw.include)
  return { ...(include ? { include } : {}), exclude: paths(raw.exclude) ?? [] }
}

// The pipeline validated hobwork.json against the schema before it reached main.
export function parseProjectConfig(raw: string): ProjectConfig {
  const json = parseHobworkJson(raw) as Partial<Omit<ProjectConfig, 'idleTimeoutMs' | 'static' | 'uploads' | 'widget' | 'intents' | 'share' | 'appLinks'>> & {
    idleTimeout?: string
    share?: unknown
    appLinks?: unknown
    widget?: { route?: unknown }
    intents?: unknown
    static?: Record<string, { dir?: unknown; public?: unknown }>
    uploads?: Record<string, { prefix?: unknown; maxBytes?: unknown; types?: unknown }>
  }
  return {
    routes: json.routes ?? {},
    crons: json.crons ?? {},
    webhooks: json.webhooks ?? {},
    triggers: json.triggers ?? {},
    egress: json.egress ?? [],
    csp: json.csp ?? {},
    resources: json.resources ?? {},
    crossAppRequests: json.crossAppRequests ?? [],
    static: staticMounts(json.static),
    uploads: uploadEntries(json.uploads),
    idleTimeoutMs: json.idleTimeout ? Math.min(parseDuration(json.idleTimeout), MAX_IDLE_TIMEOUT_MS) : DEFAULT_IDLE_TIMEOUT_MS,
    ...(typeof json.widget?.route === 'string' ? { widget: json.widget.route } : {}),
    intents: intentEntries(json.intents),
    share: shareEntries(json.share),
    appLinks: appLinks(json.appLinks),
  }
}

export async function readProjectConfig(host: Host, project: string, commit: string): Promise<ProjectConfig> {
  let raw: string
  try {
    raw = await git(['--git-dir', repoPath(host, project), 'show', `${commit}:hobwork.json`])
  } catch (err) {
    if (err instanceof GitError) throw new ProjectError(`hobwork.json is missing in ${project} at ${commit}`)
    throw err
  }
  try {
    return parseProjectConfig(raw)
  } catch (err) {
    throw new ProjectError(`hobwork.json in ${project} at ${commit} is invalid: ${(err as Error).message}`)
  }
}

export function entriesOf(config: ProjectConfig, kind: InvocationKind): Record<string, Entry> {
  const byKind: Record<InvocationKind, Record<string, Entry>> = {
    route: config.routes,
    cron: config.crons,
    webhook: config.webhooks,
    trigger: config.triggers,
  }
  return byKind[kind]
}

export function allHandlers(config: ProjectConfig): string[] {
  const kinds: InvocationKind[] = ['route', 'cron', 'webhook', 'trigger']
  return [...new Set(kinds.flatMap((kind) => Object.values(entriesOf(config, kind)).map((e) => e.handler)))]
}
