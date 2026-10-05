import { EventEmitter } from 'node:events'
import { publishChange } from '../changes.ts'
import type { Host } from '../host.ts'
import { truncateMiddle } from '../mcp/output.ts'
import { DEFAULT_BRANCH, requireProject } from '../projects.ts'

export type InvocationKind = 'route' | 'webhook' | 'cron' | 'trigger'
export type InvocationStatus = 'running' | 'ok' | 'error'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSource = 'handler' | 'runtime' | 'pipeline'
export type LifecycleEvent =
  | 'start'
  | 'stop'
  | 'crash'
  | 'deploy'
  | 'auto-revert'
  | 'egress-blocked'
  | 'trigger'
  | 'pipeline'
  | 'migration'
  | 'db'
  | 'secret'
  | 'project'
  | 'ai-limit'
  | 'home-assistant'

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export type InvocationRecord = {
  id: number
  project: string
  version: number | null
  // Set for a branch preview; null for the deployed version on main.
  branch: string | null
  kind: InvocationKind
  name: string
  manual: boolean
  status: InvocationStatus
  httpStatus: number | null
  error: string | null
  stack: string | null
  startedAt: string
  durationMs: number | null
}

export type LogEntry = {
  id: number
  project: string
  branch: string | null
  invocationId: number | null
  source: LogSource
  level: LogLevel
  event: LifecycleEvent | null
  message: string
  time: string
}

export type NewLogEntry = {
  project: string
  // For lines from a branch preview.
  branch?: string
  invocationId?: number
  source: LogSource
  level: LogLevel
  event?: LifecycleEvent
  message: string
  time?: string
}

export const MAX_MESSAGE_CHARS = 8_000
const RETENTION_DAYS = 30
const MAX_LOG_ROWS_PER_PROJECT = 200_000

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

// Wakes tail_logs waiters. Keyed by project name.
const appended = new EventEmitter()
appended.setMaxListeners(0)

function projectId(host: Host, project: string): number {
  return requireProject(host, project).id
}

export function startInvocation(
  host: Host,
  invocation: {
    project: string
    version: number | null
    branch?: string
    kind: InvocationKind
    name: string
    manual: boolean
  },
): number {
  const row = host.db
    .prepare('INSERT INTO invocations (project_id, version, branch, kind, name, manual) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .get(
      projectId(host, invocation.project),
      invocation.version,
      invocation.branch ?? null,
      invocation.kind,
      invocation.name,
      invocation.manual ? 1 : 0,
    )
  if (!row) throw new Error('Invocation insert returned no row')
  const id = Number(row.id)
  publishChange(host.db, { kind: 'invocations', project: invocation.project, id })
  return id
}

export function finishInvocation(
  host: Host,
  id: number,
  result: { status: 'ok' | 'error'; durationMs: number; httpStatus?: number; error?: string; stack?: string },
): void {
  const row = host.db
    .prepare(
      `UPDATE invocations SET status = ?, duration_ms = ?, http_status = ?, error = ?, stack = ? WHERE id = ?
       RETURNING (SELECT name FROM projects WHERE id = project_id) AS project`,
    )
    .get(
      result.status,
      Math.round(result.durationMs),
      result.httpStatus ?? null,
      result.error === undefined ? null : truncateMiddle(result.error, MAX_MESSAGE_CHARS),
      result.stack === undefined ? null : truncateMiddle(result.stack, MAX_MESSAGE_CHARS),
      id,
    )
  if (row) publishChange(host.db, { kind: 'invocations', project: String(row.project), id })
}

// Invocations do not survive a host restart.
export function failInterruptedInvocations(host: Host): void {
  host.db
    .prepare(
      `UPDATE invocations SET status = 'error', error = 'Interrupted by a host restart',
         duration_ms = CAST((julianday(${NOW}) - julianday(started_at)) * 86400000 AS INTEGER)
       WHERE status = 'running'`,
    )
    .run()
}

const SELECT_INVOCATION = `SELECT i.id, p.name AS project, i.version, i.branch, i.kind, i.name, i.manual, i.status, i.http_status,
    i.error, i.stack, i.started_at, i.duration_ms
  FROM invocations i JOIN projects p ON p.id = i.project_id`

function conditions(sql?: string, value?: string) {
  const where: string[] = []
  const params: (string | number | null)[] = []
  const add = (condition: string, ...values: (string | number | null)[]) => {
    where.push(condition)
    params.push(...values)
  }
  if (sql !== undefined && value !== undefined) add(sql, value)
  return { where, params, add }
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value)
}

function nullableString(value: unknown): string | null {
  return value === null ? null : String(value)
}

function toInvocation(row: Record<string, unknown>): InvocationRecord {
  return {
    id: Number(row.id),
    project: String(row.project),
    version: nullableNumber(row.version),
    branch: nullableString(row.branch),
    kind: String(row.kind) as InvocationKind,
    name: String(row.name),
    manual: row.manual === 1,
    status: String(row.status) as InvocationStatus,
    httpStatus: nullableNumber(row.http_status),
    error: nullableString(row.error),
    stack: nullableString(row.stack),
    startedAt: String(row.started_at),
    durationMs: nullableNumber(row.duration_ms),
  }
}

export function getInvocation(host: Host, id: number): InvocationRecord | undefined {
  const row = host.db.prepare(`${SELECT_INVOCATION} WHERE i.id = ?`).get(id)
  return row ? toInvocation(row) : undefined
}

export const ALL_BRANCHES = '*'

// Branch previews are kept out of logs and runs unless asked for: main when
// left out, every version for '*', or one branch's previews.
export function branchFilter(value: string | null | undefined): string | null | undefined {
  if (value === ALL_BRANCHES) return undefined
  return !value || value === DEFAULT_BRANCH ? null : value
}

export type InvocationFilter = {
  // All projects when left out.
  project?: string
  // A branch name, or null for main only. Undefined means all.
  branch?: string | null
  kind?: InvocationKind
  name?: string
  status?: InvocationStatus
  version?: number
  since?: string
  beforeId?: number
  // Started before this time.
  before?: string
  limit: number
}

// Newest first.
export function listInvocations(host: Host, filter: InvocationFilter): InvocationRecord[] {
  const { where, params, add } = conditions(filter.project === undefined ? undefined : 'p.name = ?', filter.project)
  if (filter.branch !== undefined) add('i.branch IS ?', filter.branch)
  if (filter.kind) add('i.kind = ?', filter.kind)
  if (filter.name) add('i.name = ?', filter.name)
  if (filter.status) add('i.status = ?', filter.status)
  if (filter.version !== undefined) add('i.version = ?', filter.version)
  if (filter.since) add('i.started_at >= ?', filter.since)
  if (filter.beforeId !== undefined) add('i.id < ?', filter.beforeId)
  if (filter.before) add('i.started_at < ?', filter.before)
  return host.db
    .prepare(`${SELECT_INVOCATION} WHERE ${where.join(' AND ') || '1'} ORDER BY i.id DESC LIMIT ?`)
    .all(...params, filter.limit)
    .map(toInvocation)
}

export function appendLogs(host: Host, entries: NewLogEntry[]): void {
  if (!entries.length) return
  const insert = host.db.prepare(
    `INSERT INTO logs (project_id, branch, invocation_id, source, level, event, message, time)
     VALUES (?, ?, ?, ?, ?, ?, ?, coalesce(?, ${NOW}))`,
  )
  const ids = new Map<string, number>()
  const projects = new Set<string>()
  host.db.exec('BEGIN')
  try {
    for (const entry of entries) {
      let id = ids.get(entry.project)
      if (id === undefined) ids.set(entry.project, (id = projectId(host, entry.project)))
      insert.run(
        id,
        entry.branch ?? null,
        entry.invocationId ?? null,
        entry.source,
        entry.level,
        entry.event ?? null,
        truncateMiddle(entry.message, MAX_MESSAGE_CHARS),
        entry.time ?? null,
      )
      projects.add(entry.project)
    }
    host.db.exec('COMMIT')
  } catch (err) {
    host.db.exec('ROLLBACK')
    throw err
  }
  for (const project of projects) {
    appended.emit(project)
    publishChange(host.db, { kind: 'logs', project })
  }
}

export function appendLog(host: Host, entry: NewLogEntry): void {
  appendLogs(host, [entry])
}

export type LogFilter = {
  project: string
  // A branch name, or null for main only. Undefined means all.
  branch?: string | null
  invocationId?: number
  // Log IDs are a cursor: lines after this one.
  afterId?: number
  since?: string
  until?: string
  source?: LogSource
  minLevel?: LogLevel
  // Only lifecycle lines (deploys, starts, crashes, blocked requests, ...).
  eventsOnly?: boolean
  limit: number
}

const SELECT_LOG = `SELECT l.id, p.name AS project, l.branch, l.invocation_id, l.source, l.level, l.event, l.message, l.time
  FROM logs l JOIN projects p ON p.id = l.project_id`

function toLog(row: Record<string, unknown>): LogEntry {
  return {
    id: Number(row.id),
    project: String(row.project),
    branch: nullableString(row.branch),
    invocationId: nullableNumber(row.invocation_id),
    source: String(row.source) as LogSource,
    level: String(row.level) as LogLevel,
    event: nullableString(row.event) as LifecycleEvent | null,
    message: String(row.message),
    time: String(row.time),
  }
}

// Oldest first. Without afterId or since, returns the latest `limit` lines.
export function queryLogs(host: Host, filter: LogFilter): LogEntry[] {
  const { where, params, add } = conditions('p.name = ?', filter.project)
  if (filter.invocationId !== undefined) add('l.invocation_id = ?', filter.invocationId)
  if (filter.branch !== undefined) add('l.branch IS ?', filter.branch)
  if (filter.afterId !== undefined) add('l.id > ?', filter.afterId)
  if (filter.since) add('l.time >= ?', filter.since)
  if (filter.until) add('l.time <= ?', filter.until)
  if (filter.source) add('l.source = ?', filter.source)
  if (filter.eventsOnly) where.push('l.event IS NOT NULL')
  if (filter.minLevel && filter.minLevel !== 'debug') {
    const levels = LOG_LEVELS.slice(LOG_LEVELS.indexOf(filter.minLevel))
    add(`l.level IN (${levels.map(() => '?').join(', ')})`, ...levels)
  }
  const fromStart = filter.afterId !== undefined || filter.since !== undefined || filter.invocationId !== undefined
  const rows = host.db
    .prepare(`${SELECT_LOG} WHERE ${where.join(' AND ')} ORDER BY l.id ${fromStart ? 'ASC' : 'DESC'} LIMIT ?`)
    .all(...params, filter.limit)
    .map(toLog)
  return fromStart ? rows : rows.reverse()
}

export function lastLogId(host: Host, project: string): number {
  const row = host.db
    .prepare('SELECT max(l.id) AS id FROM logs l JOIN projects p ON p.id = l.project_id WHERE p.name = ?')
    .get(project)
  return row?.id === null || row?.id === undefined ? 0 : Number(row.id)
}

// Resolves when a line is appended for the project, or after timeoutMs.
export function waitForLogs(project: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      appended.off(project, done)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    appended.on(project, done)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export function pruneLogs(host: Host): void {
  host.db.exec(`
    DELETE FROM logs WHERE time < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${RETENTION_DAYS} days');
    DELETE FROM invocations WHERE started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${RETENTION_DAYS} days');
  `)
  const trim = host.db.prepare(
    `DELETE FROM logs WHERE project_id = ?1 AND id <= (
       SELECT id FROM logs WHERE project_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2
     )`,
  )
  for (const row of host.db.prepare('SELECT id FROM projects').all()) trim.run(Number(row.id), MAX_LOG_ROWS_PER_PROJECT)
}

// The newest invocation on main of every entry point, keyed by `${kind} ${name}`.
export function latestInvocations(host: Host, project: string): Map<string, InvocationRecord> {
  const rows = host.db
    .prepare(
      `${SELECT_INVOCATION} WHERE i.id IN (
         SELECT max(i2.id) FROM invocations i2 JOIN projects p2 ON p2.id = i2.project_id
         WHERE p2.name = ? AND i2.branch IS NULL GROUP BY i2.kind, i2.name
       )`,
    )
    .all(project)
    .map(toInvocation)
  return new Map(rows.map((i) => [`${i.kind} ${i.name}`, i]))
}
