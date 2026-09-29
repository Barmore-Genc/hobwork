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
// Event types are case sensitive in Home Assistant, so unlike services they keep their case.
const EVENT_PREFIX = 'event:'
const EVENT_TYPE = /^[A-Za-z0-9_.-]{1,100}$/

// Events Home Assistant fires itself or listens to for its own state. Firing
// them from a hob would fake state changes, service calls or registry updates
// that automations and integrations trust.
const BLOCKED_EVENTS = new Set([
  'call_service',
  'state_changed',
  'service_registered',
  'service_removed',
  'component_loaded',
  'core_config_updated',
  'themes_updated',
  'panels_updated',
  'logbook_entry',
  'automation_triggered',
  'automation_reloaded',
  'script_started',
  'scene_reloaded',
  'user_added',
  'user_removed',
  'mobile_app_notification_action',
  'shopping_list_updated',
])
const BLOCKED_EVENT_PREFIXES = ['homeassistant_', 'hassio_']
const MAX_ENTRIES = 500

export class HaServicesError extends Error {}

export const WHERE_TO_CHANGE = "People change this on the hob's Home Assistant page in Hobwork"

export function isBlockedService(domain: string, service?: string): boolean {
  return BLOCKED_DOMAINS.has(domain) || (service !== undefined && BLOCKED_SERVICES.has(`${domain}.${service}`))
}

export function isBlockedEvent(type: string): boolean {
  const lower = type.toLowerCase()
  return (
    BLOCKED_EVENTS.has(lower) ||
    BLOCKED_EVENT_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    lower.endsWith('_registry_updated')
  )
}

export function eventsAllow(entries: string[], type: string): boolean {
  return entries.includes(`${EVENT_PREFIX}${type}`)
}

export function parseServiceEntries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HaServicesError('The list must have domains like "light", services like "light.turn_on" or events like "event:my_hob_changed"')
  }
  const entries = [
    ...new Set(
      value.map((entry) => {
        if (typeof entry !== 'string') return entry
        const trimmed = entry.trim()
        return trimmed.toLowerCase().startsWith(EVENT_PREFIX) ? `${EVENT_PREFIX}${trimmed.slice(EVENT_PREFIX.length)}` : trimmed.toLowerCase()
      }),
    ),
  ]
  if (entries.length > MAX_ENTRIES) throw new HaServicesError(`List at most ${MAX_ENTRIES} entries`)
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.startsWith(EVENT_PREFIX)) {
      const type = entry.slice(EVENT_PREFIX.length)
      if (!EVENT_TYPE.test(type)) {
        throw new HaServicesError(`${JSON.stringify(entry.slice(0, 60))} is not an event like "event:my_hob_changed" (letters, digits, _, . and -)`)
      }
      if (isBlockedEvent(type)) {
        throw new HaServicesError(`${type} is an event Home Assistant uses for itself, so Hobwork does not let any hob fire it`)
      }
      continue
    }
    if (typeof entry !== 'string' || !ENTRY.test(entry)) {
      throw new HaServicesError(
        `${JSON.stringify(typeof entry === 'string' ? entry.slice(0, 60) : entry)} is not a domain like "light", a service like "light.turn_on" or an event like "event:my_hob_changed"`,
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
    host.db.prepare('DELETE FROM project_ha_events_backfill WHERE project_id = ?').run(id)
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
      message: `${who} changed the Home Assistant services and events this hob may use: ${parts.filter(Boolean).join('; ')}`,
    })
  }
  publishChange(host.db, { kind: 'project', project })
  return entries
}

export function haServicesNote(entries: string[]): string {
  const services = entries.filter((entry) => !entry.startsWith(EVENT_PREFIX))
  const events = entries.filter((entry) => entry.startsWith(EVENT_PREFIX)).map((entry) => entry.slice(EVENT_PREFIX.length))
  const serviceNote = services.length
    ? `Handlers may call these Home Assistant services: ${services.join(', ')}. Anything else is refused.`
    : 'Handlers may not call any Home Assistant service yet.'
  const eventNote = events.length
    ? `They may fire these events: ${events.join(', ')}. Any other fireEvent is refused.`
    : 'They may not fire any event yet.'
  return `${serviceNote} ${eventNote}`
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
async function* deployedSources(host: Host, project: string): AsyncGenerator<string> {
  const files = (await listFilesAtRef(host, project, DEFAULT_BRANCH)).filter(
    (path) => SOURCE_FILE.test(path) && !path.split('/').includes('node_modules') && !/\.(?:test|spec)\./.test(path),
  )
  for (const path of files) {
    const source = await readFileAtRef(host, project, DEFAULT_BRANCH, path)
    if (source !== undefined && source.length <= MAX_SOURCE_BYTES) yield source
  }
}

export async function deployedServiceDomains(host: Host, project: string): Promise<{ domains: string[]; dynamic: boolean }> {
  const domains = new Set<string>()
  let dynamic = false
  for await (const source of deployedSources(host, project)) {
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

const LITERAL_EVENT = /\bfireEvent\s*\(\s*(['"`])([A-Za-z0-9_.-]{1,100})\1/g
const ANY_EVENT = /\bfireEvent\s*\(/g

export function findEventFires(source: string): { events: string[]; dynamic: boolean } {
  const events = [...source.matchAll(LITERAL_EVENT)].map((match) => match[2]!)
  return { events, dynamic: [...source.matchAll(ANY_EVENT)].length > events.length }
}

// Like the services, the events the hob's logs show it firing count too.
export async function deployedEventTypes(host: Host, project: string): Promise<{ events: string[]; dynamic: boolean }> {
  const events = new Set<string>()
  let dynamic = false
  for await (const source of deployedSources(host, project)) {
    const found = findEventFires(source)
    for (const type of found.events) events.add(type)
    dynamic ||= found.dynamic
  }
  const { id } = requireProject(host, project)
  for (const row of host.db
    .prepare(`SELECT DISTINCT message FROM logs WHERE project_id = ? AND source = 'runtime' AND event IS NULL AND message LIKE 'Home Assistant: fire event %'`)
    .all(id)) {
    const match = /^Home Assistant: fire event ([A-Za-z0-9_.-]{1,100})(?: |$)/.exec(String(row.message))
    if (match) events.add(match[1]!)
  }
  return { events: [...events].filter((type) => !isBlockedEvent(type)).sort(), dynamic }
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

export async function backfillHaEvents(host: Host): Promise<void> {
  const pending = host.db
    .prepare('SELECT p.id, p.name FROM project_ha_events_backfill b JOIN projects p ON p.id = b.project_id')
    .all()
  for (const row of pending) {
    const id = Number(row.id)
    const name = String(row.name)
    try {
      const { events, dynamic } = await deployedEventTypes(host, name)
      host.db.exec('BEGIN IMMEDIATE')
      try {
        const insert = host.db.prepare('INSERT OR IGNORE INTO project_ha_services (project_id, entry) VALUES (?, ?)')
        for (const type of events) insert.run(id, `${EVENT_PREFIX}${type}`)
        host.db.prepare('DELETE FROM project_ha_events_backfill WHERE project_id = ?').run(id)
        host.db.exec('COMMIT')
      } catch (err) {
        host.db.exec('ROLLBACK')
        throw err
      }
      if (events.length || dynamic) {
        appendLog(host, {
          project: name,
          source: 'runtime',
          level: dynamic ? 'warn' : 'info',
          event: 'home-assistant',
          message:
            'Hobwork now limits the Home Assistant events this hob may fire. ' +
            (events.length ? `Its deployed code already fires ${events.join(', ')}, so those events are allowed. ` : '') +
            (dynamic ? 'Some calls name their event in a variable, so Hobwork could not tell which. Add what they need if a call is refused. ' : '') +
            `${WHERE_TO_CHANGE}.`,
        })
      }
    } catch (err) {
      console.error(`Could not work out the Home Assistant events of ${name}`, err)
    }
  }
}
