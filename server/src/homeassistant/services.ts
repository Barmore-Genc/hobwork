import type { DatabaseSync } from 'node:sqlite'
import { publishChange } from '../changes.ts'
import type { Host } from '../host.ts'
import { DEFAULT_BRANCH, requireProject } from '../projects.ts'
import { listFilesAtRef, readFileAtRef } from '../repo.ts'
import { appendLog } from '../runtime/logs.ts'

// Services that change or stop Home Assistant itself, or run commands on its
// machine. No hob may call them, even when its list names them.
const BLOCKED_DOMAINS = new Set(['hassio', 'homeassistant', 'shell_command'])
const BLOCKED_SERVICES = new Set(['recorder.purge', 'recorder.purge_entities'])

const ENTRY = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/
const MAX_ENTRIES = 500

export class HaServicesError extends Error {}

export const WHERE_TO_CHANGE = "People change this on the hob's Home Assistant page in Hobwork"

export function isBlockedService(domain: string, service?: string): boolean {
  return BLOCKED_DOMAINS.has(domain) || (service !== undefined && BLOCKED_SERVICES.has(`${domain}.${service}`))
}

export function parseServiceEntries(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HaServicesError('services must be a list of domains like "light" or services like "light.turn_on"')
  const entries = [...new Set(value.map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : entry)))]
  if (entries.length > MAX_ENTRIES) throw new HaServicesError(`List at most ${MAX_ENTRIES} entries`)
  for (const entry of entries) {
    if (typeof entry !== 'string' || !ENTRY.test(entry)) {
      throw new HaServicesError(
        `${JSON.stringify(typeof entry === 'string' ? entry.slice(0, 60) : entry)} is not a domain like "light" or a service like "light.turn_on"`,
      )
    }
    const [domain, service] = entry.split('.') as [string, string | undefined]
    if (isBlockedService(domain, service)) {
      throw new HaServicesError(`${entry} changes Home Assistant itself, so Hobwork does not let any hob call it`)
    }
  }
  return (entries as string[]).sort()
}

export function servicesAllow(entries: string[], domain: string, service: string): boolean {
  return entries.includes(domain) || entries.includes(`${domain}.${service}`)
}

export function getHaServices(db: DatabaseSync, projectId: number): string[] {
  return db
    .prepare('SELECT entry FROM project_ha_services WHERE project_id = ? ORDER BY entry')
    .all(projectId)
    .map((row) => String(row.entry))
}

export type ServicesActor = { kind: 'user' | 'agent'; name: string }

export function setHaServices(host: Host, project: string, value: unknown, actor: ServicesActor): string[] {
  const entries = parseServiceEntries(value)
  const { id } = requireProject(host, project)
  const before = getHaServices(host.db, id)
  host.db.exec('BEGIN IMMEDIATE')
  try {
    host.db.prepare('DELETE FROM project_ha_services WHERE project_id = ?').run(id)
    const insert = host.db.prepare('INSERT INTO project_ha_services (project_id, entry) VALUES (?, ?)')
    for (const entry of entries) insert.run(id, entry)
    host.db.prepare('DELETE FROM project_ha_services_backfill WHERE project_id = ?').run(id)
    host.db.exec('COMMIT')
  } catch (err) {
    host.db.exec('ROLLBACK')
    throw err
  }
  const added = entries.filter((entry) => !before.includes(entry))
  const removed = before.filter((entry) => !entries.includes(entry))
  if (added.length || removed.length) {
    const who = actor.kind === 'agent' ? `Agent ${actor.name}` : actor.name
    const parts = [added.length && `allowed ${added.join(', ')}`, removed.length && `no longer allowed ${removed.join(', ')}`]
    appendLog(host, {
      project,
      source: 'runtime',
      level: 'info',
      event: 'home-assistant',
      message: `${who} changed the Home Assistant services this hob may call: ${parts.filter(Boolean).join('; ')}`,
    })
  }
  publishChange(host.db, { kind: 'project', project })
  return entries
}

export function haServicesNote(entries: string[]): string {
  return entries.length
    ? `Handlers may call these Home Assistant services: ${entries.join(', ')}. Anything else is refused.`
    : 'Handlers may not call any Home Assistant service yet.'
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const LITERAL_CALL = /\bcallService\s*\(\s*(['"`])([a-z0-9_]+)\1\s*,\s*(['"`])([a-z0-9_]+)\3/g
const ANY_CALL = /\bcallService\s*\(/g
const MAX_SOURCE_BYTES = 1_000_000

export function findServiceCalls(source: string): { services: string[]; dynamic: boolean } {
  const services = [...source.matchAll(LITERAL_CALL)].map((match) => `${match[2]}.${match[4]}`)
  return { services, dynamic: [...source.matchAll(ANY_CALL)].length > services.length }
}

// A call whose domain is not a string literal cannot be read from the source,
// so the calls recorded in the hob's log count too.
export async function deployedServiceDomains(host: Host, project: string): Promise<{ domains: string[]; dynamic: boolean }> {
  const domains = new Set<string>()
  let dynamic = false
  const files = (await listFilesAtRef(host, project, DEFAULT_BRANCH)).filter(
    (path) => SOURCE_FILE.test(path) && !path.split('/').includes('node_modules') && !/\.(?:test|spec)\./.test(path),
  )
  for (const path of files) {
    const source = await readFileAtRef(host, project, DEFAULT_BRANCH, path)
    if (source === undefined || source.length > MAX_SOURCE_BYTES) continue
    const found = findServiceCalls(source)
    for (const service of found.services) domains.add(service.split('.')[0]!)
    dynamic ||= found.dynamic
  }
  const { id } = requireProject(host, project)
  for (const row of host.db
    .prepare(`SELECT DISTINCT message FROM logs WHERE project_id = ? AND source = 'runtime' AND event IS NULL AND message LIKE 'Home Assistant: %'`)
    .all(id)) {
    const match = /^Home Assistant: ([a-z0-9_]+)\.[a-z0-9_]+(?: |$)/.exec(String(row.message))
    if (match) domains.add(match[1]!)
  }
  return { domains: [...domains].filter((domain) => !isBlockedService(domain)).sort(), dynamic }
}

// A hob whose code cannot be read stays on the list to backfill and is tried
// again on the next start.
export async function backfillHaServices(host: Host): Promise<void> {
  const pending = host.db
    .prepare('SELECT p.id, p.name FROM project_ha_services_backfill b JOIN projects p ON p.id = b.project_id')
    .all()
  for (const row of pending) {
    const id = Number(row.id)
    const name = String(row.name)
    try {
      const { domains, dynamic } = await deployedServiceDomains(host, name)
      host.db.exec('BEGIN IMMEDIATE')
      try {
        const insert = host.db.prepare('INSERT OR IGNORE INTO project_ha_services (project_id, entry) VALUES (?, ?)')
        for (const domain of domains) insert.run(id, domain)
        host.db.prepare('DELETE FROM project_ha_services_backfill WHERE project_id = ?').run(id)
        host.db.exec('COMMIT')
      } catch (err) {
        host.db.exec('ROLLBACK')
        throw err
      }
      if (domains.length || dynamic) {
        appendLog(host, {
          project: name,
          source: 'runtime',
          level: dynamic ? 'warn' : 'info',
          event: 'home-assistant',
          message:
            'Hobwork now limits the Home Assistant services this hob may call. ' +
            (domains.length ? `Its deployed code already calls ${domains.join(', ')}, so those domains are allowed. ` : '') +
            (dynamic ? 'Some calls name their service in a variable, so Hobwork could not tell which. Add what they need if a call is refused. ' : '') +
            `${WHERE_TO_CHANGE}.`,
        })
      }
    } catch (err) {
      console.error(`Could not work out the Home Assistant services of ${name}`, err)
    }
  }
}
