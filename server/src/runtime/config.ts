import { parseHobworkJson } from '../../../packages/sdk/src/hobwork-json.js'
import { git, GitError } from '../git.ts'
import { repoPath, type Host } from '../host.ts'
import type { TriggerEntry } from '../homeassistant/triggers.ts'
import { ProjectError } from '../projects.ts'
import type { CspSources } from './csp.ts'
import type { InvocationKind } from './logs.ts'

export type Entry = { handler: string }

export type ProjectConfig = {
  routes: Record<string, Entry>
  crons: Record<string, Entry & { schedule: string }>
  webhooks: Record<string, Entry>
  triggers: Record<string, Entry & TriggerEntry>
  egress: string[]
  csp: CspSources
  idleTimeoutMs: number
}

export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text)
  if (!match) throw new ProjectError(`"${text}" is not a duration like 30s, 15m or 1h`)
  return Number(match[1]) * UNITS[match[2]!]!
}

// The pipeline validated hobwork.json against the schema before it reached main.
export function parseProjectConfig(raw: string): ProjectConfig {
  const json = parseHobworkJson(raw) as Partial<Omit<ProjectConfig, 'idleTimeoutMs'>> & { idleTimeout?: string }
  return {
    routes: json.routes ?? {},
    crons: json.crons ?? {},
    webhooks: json.webhooks ?? {},
    triggers: json.triggers ?? {},
    egress: json.egress ?? [],
    csp: json.csp ?? {},
    idleTimeoutMs: json.idleTimeout ? parseDuration(json.idleTimeout) : DEFAULT_IDLE_TIMEOUT_MS,
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
