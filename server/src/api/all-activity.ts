import type { Host } from '../host.ts'
import { HttpError, json } from '../http.ts'
import { getProject } from '../projects.ts'
import { listInvocations, type InvocationRecord, type LifecycleEvent, type LogLevel } from '../runtime/logs.ts'
import type { ApiRoute } from './router.ts'
import {
  INVOCATION_KINDS,
  INVOCATION_STATUSES,
  invocationView,
  pageSize,
  queryEnum,
  queryInt,
  queryTime,
} from './routes.ts'

const PAGE = 50
const MAX_PAGE = 200
const MAX_ATTENTION = 99

export type ProblemEvent = {
  id: number
  project: string
  branch: string | null
  invocationId: number | null
  level: LogLevel
  event: LifecycleEvent
  message: string
  time: string
}

export type Problem =
  | { type: 'run'; time: string; run: ReturnType<typeof invocationView> }
  | { type: 'event'; time: string; event: ProblemEvent }

// Lifecycle events at warn or error: blocked requests, rollbacks, crashes,
// DB warnings, refused triggers, failed deploys.
function problemEvents(host: Host, filter: { project?: string; since?: string; before?: string; limit: number }): ProblemEvent[] {
  const where = ["l.event IS NOT NULL", "l.level IN ('warn', 'error')"]
  const params: (string | number)[] = []
  if (filter.project) {
    where.push('p.name = ?')
    params.push(filter.project)
  }
  if (filter.since) {
    where.push('l.time >= ?')
    params.push(filter.since)
  }
  if (filter.before) {
    where.push('l.time < ?')
    params.push(filter.before)
  }
  return host.db
    .prepare(
      `SELECT l.id, p.name AS project, l.branch, l.invocation_id, l.level, l.event, l.message, l.time
       FROM logs l JOIN projects p ON p.id = l.project_id
       WHERE ${where.join(' AND ')} ORDER BY l.time DESC, l.id DESC LIMIT ?`,
    )
    .all(...params, filter.limit)
    .map((row) => ({
      id: Number(row.id),
      project: String(row.project),
      branch: row.branch === null ? null : String(row.branch),
      invocationId: row.invocation_id === null ? null : Number(row.invocation_id),
      level: String(row.level) as LogLevel,
      event: String(row.event) as LifecycleEvent,
      message: String(row.message),
      time: String(row.time),
    }))
}

function failedRuns(host: Host, filter: { project?: string; since?: string; before?: string; limit: number }): InvocationRecord[] {
  return listInvocations(host, { ...filter, status: 'error' })
}

function projectFilter(host: Host, query: URLSearchParams): string | undefined {
  const project = query.get('project') || undefined
  if (project && !getProject(host, project)) throw new HttpError(404, `There is no project called "${project}"`)
  return project
}

// Runs and problems of every project, for signed-in people.
export function allActivityRoutes(host: Host): ApiRoute[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/activity$/,
      handle: ({ res, query }) => {
        const limit = pageSize(query, PAGE, MAX_PAGE)
        const rows = listInvocations(host, {
          project: projectFilter(host, query),
          kind: queryEnum(query, 'kind', INVOCATION_KINDS),
          status: queryEnum(query, 'status', INVOCATION_STATUSES),
          since: queryTime(query, 'since'),
          beforeId: queryInt(query, 'before'),
          limit: limit + 1,
        })
        json(res, 200, { invocations: rows.slice(0, limit).map((i) => invocationView(i, false)), more: rows.length > limit })
      },
    },
    {
      // Failed runs and problem events, newest first. `before` is the time of
      // the last item of the previous page.
      method: 'GET',
      pattern: /^\/api\/activity\/problems$/,
      handle: ({ res, query }) => {
        const limit = pageSize(query, PAGE, MAX_PAGE)
        const filter = {
          project: projectFilter(host, query),
          since: queryTime(query, 'since'),
          before: queryTime(query, 'before'),
          limit: limit + 1,
        }
        const items: Problem[] = [
          ...failedRuns(host, filter).map((run) => ({ type: 'run' as const, time: run.startedAt, run: invocationView(run, false) })),
          ...problemEvents(host, filter).map((event) => ({ type: 'event' as const, time: event.time, event })),
        ].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
        json(res, 200, { items: items.slice(0, limit), more: items.length > limit })
      },
    },
    {
      // How many problems happened since the person last looked, for the nav.
      method: 'GET',
      pattern: /^\/api\/activity\/attention$/,
      handle: ({ res, query }) => {
        const since = queryTime(query, 'since')
        if (!since) throw new HttpError(400, 'since is required')
        const limit = MAX_ATTENTION + 1
        const count = failedRuns(host, { since, limit }).length + problemEvents(host, { since, limit }).length
        json(res, 200, { count: Math.min(count, MAX_ATTENTION), more: count > MAX_ATTENTION })
      },
    },
  ]
}
