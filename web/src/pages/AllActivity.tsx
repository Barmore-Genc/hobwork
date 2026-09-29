import { useEffect, useState } from 'react'
import { api, ApiError, type ActivityRun, type InvocationKind, type InvocationStatus, type Problem } from '../api.ts'
import { markProblemsSeen, useAttention } from '../attention.ts'
import { exactTime, timeAgo } from '../format.ts'
import { navigate, useLocation } from '../navigation.ts'
import { Link } from '../router.tsx'
import { Button, Notice, PageHeading } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'
import { RunRow, selectClass } from './project/Activity.tsx'
import { EVENT_LABELS, KIND_LABELS, projectPath } from './project/names.ts'

type View = 'runs' | 'problems'

// Events show up here only as warnings and errors, so they are named as problems.
const PROBLEM_LABELS: Record<string, string> = {
  'egress-blocked': 'Blocked request',
  'auto-revert': 'Rolled back',
  crash: 'Crashed',
  db: 'Data warning',
  migration: 'Data change failed',
  deploy: 'Update problem',
  trigger: 'Home Assistant trigger problem',
  'ai-limit': 'AI limit reached',
}

type Filter = { view: View; project: string; kind: InvocationKind | ''; status: InvocationStatus | '' }

function readFilter(search: URLSearchParams): Filter {
  const kind = search.get('kind') ?? ''
  const status = search.get('status') ?? ''
  return {
    view: search.get('view') === 'problems' ? 'problems' : 'runs',
    project: search.get('project') ?? '',
    kind: kind in KIND_LABELS ? (kind as InvocationKind) : '',
    status: ['ok', 'error', 'running'].includes(status) ? (status as InvocationStatus) : '',
  }
}

function filterPath(filter: Filter): string {
  const search = new URLSearchParams()
  if (filter.view === 'problems') search.set('view', 'problems')
  if (filter.project) search.set('project', filter.project)
  if (filter.view === 'runs' && filter.kind) search.set('kind', filter.kind)
  if (filter.view === 'runs' && filter.status) search.set('status', filter.status)
  const text = search.toString()
  return text ? `/activity?${text}` : '/activity'
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function EventRow({ problem }: { problem: Extract<Problem, { type: 'event' }> }) {
  const { event } = problem
  const to =
    event.invocationId !== null
      ? projectPath(event.project, `/activity/${event.invocationId}`)
      : projectPath(event.project, '/log')
  return (
    <li>
      <Link to={to} className="group grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-1 py-3.5 sm:grid-cols-[auto_1fr_auto]">
        <span className="pt-2">
          <span
            className={`block size-2.5 rounded-sm ${event.level === 'error' ? 'bg-danger' : 'bg-warning'}`}
            title={event.level === 'error' ? 'Error' : 'Warning'}
          />
        </span>
        <div className="min-w-0">
          <p className="font-semibold group-hover:text-accent-fg">{PROBLEM_LABELS[event.event] ?? EVENT_LABELS[event.event] ?? event.event}</p>
          <p className="text-sm text-muted">
            In <span className="font-semibold text-fg">{event.project}</span>
            {event.branch !== null && `, preview of ${event.branch}`}
          </p>
          <p className={`mt-1 line-clamp-2 font-mono text-[0.83rem] break-words ${event.level === 'error' ? 'text-danger' : 'text-warning'}`}>
            {event.message}
          </p>
        </div>
        <div className="col-start-2 text-sm text-muted tabular sm:col-start-3 sm:text-right">
          <time dateTime={event.time} title={exactTime(event.time)}>
            {timeAgo(event.time)}
          </time>
        </div>
      </Link>
    </li>
  )
}

function Runs({ filter }: { filter: Filter }) {
  const [runs, setRuns] = useState<ActivityRun[] | null>(null)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const query = {
    project: filter.project || undefined,
    kind: filter.kind || undefined,
    status: filter.status || undefined,
  }
  const key = JSON.stringify(query)

  useEffect(() => {
    let current = true
    api.activity(JSON.parse(key)).then(
      (page) => {
        if (!current) return
        setRuns(page.invocations)
        setMore(page.more)
        setError(null)
      },
      (err: unknown) => current && setError(message(err)),
    )
    return () => {
      current = false
    }
  }, [key])

  async function loadMore() {
    if (!runs?.length) return
    setLoadingMore(true)
    try {
      const page = await api.activity({ ...query, before: runs.at(-1)!.id })
      setRuns([...runs, ...page.invocations])
      setMore(page.more)
    } catch (err) {
      setError(message(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const filtered = filter.project !== '' || filter.kind !== '' || filter.status !== ''
  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {runs?.length === 0 && (
        <p className="text-muted">{filtered ? 'No runs match these filters.' : 'Nothing has run yet.'}</p>
      )}
      {runs && runs.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {runs.map((run) => (
            <RunRow key={run.id} project={run.project} run={run} showProject />
          ))}
        </ul>
      )}
      {more && (
        <Button className="mt-4" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show older runs'}
        </Button>
      )}
    </>
  )
}

function Problems({ project }: { project: string }) {
  const [items, setItems] = useState<Problem[] | null>(null)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    api.problems({ project: project || undefined }).then(
      (page) => {
        if (!current) return
        setItems(page.items)
        setMore(page.more)
        setError(null)
        markProblemsSeen()
      },
      (err: unknown) => current && setError(message(err)),
    )
    return () => {
      current = false
    }
  }, [project])

  async function loadMore() {
    if (!items?.length) return
    setLoadingMore(true)
    try {
      const page = await api.problems({ project: project || undefined, before: items.at(-1)!.time })
      setItems([...items, ...page.items])
      setMore(page.more)
    } catch (err) {
      setError(message(err))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {items?.length === 0 && <p className="text-muted">No problems. Everything ran as it should.</p>}
      {items && items.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {items.map((item) =>
            item.type === 'run' ? (
              <RunRow key={`run-${item.run.id}`} project={item.run.project} run={item.run} showProject />
            ) : (
              <EventRow key={`event-${item.event.id}`} problem={item} />
            ),
          )}
        </ul>
      )}
      {more && (
        <Button className="mt-4" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show older problems'}
        </Button>
      )}
    </>
  )
}

export function AllActivityPage() {
  const { pathname, search } = useLocation()
  const filter = readFilter(search)
  const { data: projects } = useLoad(api.projects)
  const attention = useAttention(pathname)

  function change(update: Partial<Filter>) {
    navigate(filterPath({ ...filter, ...update }), { replace: true })
  }

  const views: { view: View; label: string }[] = [
    { view: 'runs', label: 'All runs' },
    { view: 'problems', label: 'Problems' },
  ]

  return (
    <div>
      <PageHeading>Activity</PageHeading>
      <p className="mt-3 max-w-prose text-muted">
        What your hobs did, newest first. Problems are failed runs, blocked requests, rollbacks and data warnings.
      </p>

      <nav aria-label="Activity views" className="mt-8 overflow-x-auto border-b border-border">
        <ul className="flex gap-1">
          {views.map((item) => {
            const active = item.view === filter.view
            return (
              <li key={item.view}>
                <Link
                  to={filterPath({ ...filter, view: item.view })}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex items-center gap-2 px-3 pt-1 pb-2.5 whitespace-nowrap transition-colors ${
                    active ? 'font-semibold text-fg' : 'text-muted hover:text-fg'
                  }`}
                >
                  {item.label}
                  {item.view === 'problems' && attention.count > 0 && filter.view !== 'problems' && (
                    <span className="rounded-full bg-danger px-1.5 text-[0.75rem] leading-5 font-semibold text-on-danger tabular">
                      {attention.count}
                      {attention.more && '+'}
                      <span className="sr-only"> new</span>
                    </span>
                  )}
                  {active && (
                    <span aria-hidden="true" className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent" />
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="mt-6 flex flex-wrap gap-3">
        <label className="sr-only" htmlFor="activity-project">
          Hob
        </label>
        <select
          id="activity-project"
          className={selectClass}
          value={filter.project}
          onChange={(e) => change({ project: e.target.value })}
        >
          <option value="">All hobs</option>
          {projects?.map((project) => (
            <option key={project.name} value={project.name}>
              {project.name}
            </option>
          ))}
          {filter.project && projects && !projects.some((p) => p.name === filter.project) && (
            <option value={filter.project}>{filter.project}</option>
          )}
        </select>
        {filter.view === 'runs' && (
          <>
            <label className="sr-only" htmlFor="activity-kind">
              What started it
            </label>
            <select
              id="activity-kind"
              className={selectClass}
              value={filter.kind}
              onChange={(e) => change({ kind: e.target.value as Filter['kind'] })}
            >
              <option value="">Everything</option>
              {(Object.keys(KIND_LABELS) as InvocationKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="activity-status">
              Result
            </label>
            <select
              id="activity-status"
              className={selectClass}
              value={filter.status}
              onChange={(e) => change({ status: e.target.value as Filter['status'] })}
            >
              <option value="">Any result</option>
              <option value="error">Failed</option>
              <option value="ok">Worked</option>
              <option value="running">Running</option>
            </select>
          </>
        )}
      </div>

      <div className="mt-6">
        {filter.view === 'runs' ? <Runs filter={filter} /> : <Problems project={filter.project} />}
      </div>
    </div>
  )
}
