import { useState } from 'react'
import { api, type Invocation, type InvocationKind, type InvocationStatus } from '../../api.ts'
import { duration, exactTime, timeAgo } from '../../format.ts'
import { Link } from '../../router.tsx'
import { Button, Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { usePaged } from '../../usePaged.ts'
import { kindChanged } from '../../live.ts'
import { projectPath, KIND_LABELS } from './names.ts'
import { ProjectLayout } from './ProjectLayout.tsx'
import { RunStatus } from './runs.tsx'

const PERIODS = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'Last hour' },
  { value: '24', label: 'Last 24 hours' },
  { value: '168', label: 'Last 7 days' },
]

// branch: '' for everything, 'main' for the live version, or a branch name.
type Filter = { kind: InvocationKind | ''; status: InvocationStatus | ''; hours: string; branch: string }

function toQuery(filter: Filter, before?: number) {
  return {
    branch: filter.branch || undefined,
    kind: filter.kind || undefined,
    status: filter.status || undefined,
    since: filter.hours ? new Date(Date.now() - Number(filter.hours) * 3600_000).toISOString() : undefined,
    before,
  }
}

export const selectClass =
  'min-h-10 rounded-md border border-border bg-surface-raised px-3 text-fg focus:border-accent focus:outline-none'

export function RunRow({ project, run, showProject = false }: { project: string; run: Invocation; showProject?: boolean }) {
  return (
    <li>
      <Link
        to={projectPath(project, `/activity/${run.id}`)}
        className="group grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-1 py-3.5 sm:grid-cols-[auto_1fr_auto]"
      >
        <span className="pt-2">
          <RunStatus status={run.status} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold break-words group-hover:text-accent-fg">
            <span className={run.kind === 'route' ? 'font-mono text-[0.9rem]' : ''}>{run.name}</span>
          </p>
          <p className="text-sm text-muted">
            {KIND_LABELS[run.kind]}
            {showProject && (
              <>
                {' in '}
                <span className="font-semibold text-fg">{project}</span>
              </>
            )}
            {run.branch !== null && `, preview of ${run.branch}`}
            {run.manual && ', started by an agent'}
            {run.httpStatus !== null && `, answered ${run.httpStatus}`}
          </p>
          {run.error && <p className="mt-1 line-clamp-2 text-sm break-words text-danger">{run.error}</p>}
        </div>
        <div className="col-start-2 text-sm text-muted tabular sm:col-start-3 sm:text-right">
          <time dateTime={run.startedAt} title={exactTime(run.startedAt)}>
            {timeAgo(run.startedAt)}
          </time>
          {run.durationMs !== null && (
            <span className="sm:block">
              <span className="sm:hidden">, </span>took {duration(run.durationMs)}
            </span>
          )}
        </div>
      </Link>
    </li>
  )
}

function Runs({ project }: { project: string }) {
  const [filter, setFilter] = useState<Filter>(() => ({
    kind: '',
    status: '',
    hours: '',
    branch: new URLSearchParams(window.location.search).get('branch') ?? '',
  }))
  const { data: branches } = useLoad(() => api.branches(project), project, kindChanged('branches', project))
  const {
    items: runs,
    more,
    error,
    loadingMore,
    loadMore,
  } = usePaged<Invocation>({
    load: (oldest) =>
      api.invocations(project, toQuery(filter, oldest?.id)).then((page) => ({ items: page.invocations, more: page.more })),
    key: JSON.stringify([project, filter]),
    isOlder: (run, than) => run.id < than.id,
    live: kindChanged('invocations', project),
  })

  function changeFilter(change: Partial<Filter>) {
    setFilter({ ...filter, ...change })
  }

  const filtered = filter.kind !== '' || filter.status !== '' || filter.hours !== '' || filter.branch !== ''
  const branchNames = [...new Set([...(branches ?? []).map((b) => b.name), ...(filter.branch && filter.branch !== 'main' ? [filter.branch] : [])])]

  return (
    <section className="mt-8" aria-label="Runs">
      <p className="max-w-prose text-muted">
        Every time the hob runs, because of a schedule, a request, a webhook or something at home.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {branchNames.length > 0 && (
          <>
            <label className="sr-only" htmlFor="run-branch">
              Version
            </label>
            <select
              id="run-branch"
              className={selectClass}
              value={filter.branch}
              onChange={(e) => changeFilter({ branch: e.target.value })}
            >
              <option value="">Live and previews</option>
              <option value="main">Live version</option>
              {branchNames.map((name) => (
                <option key={name} value={name}>
                  Preview of {name}
                </option>
              ))}
            </select>
          </>
        )}
        <label className="sr-only" htmlFor="run-kind">
          What started it
        </label>
        <select
          id="run-kind"
          className={selectClass}
          value={filter.kind}
          onChange={(e) => changeFilter({ kind: e.target.value as Filter['kind'] })}
        >
          <option value="">Everything</option>
          {(Object.keys(KIND_LABELS) as InvocationKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="run-status">
          Result
        </label>
        <select
          id="run-status"
          className={selectClass}
          value={filter.status}
          onChange={(e) => changeFilter({ status: e.target.value as Filter['status'] })}
        >
          <option value="">Any result</option>
          <option value="error">Failed</option>
          <option value="ok">Worked</option>
          <option value="running">Running</option>
        </select>
        <label className="sr-only" htmlFor="run-period">
          When
        </label>
        <select
          id="run-period"
          className={selectClass}
          value={filter.hours}
          onChange={(e) => changeFilter({ hours: e.target.value })}
        >
          {PERIODS.map((period) => (
            <option key={period.value} value={period.value}>
              {period.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-6">
        {error && <Notice tone="error">{error}</Notice>}
        {runs?.length === 0 && (
          <p className="text-muted">{filtered ? 'No runs match these filters.' : 'This hob has not run yet.'}</p>
        )}
        {runs && runs.length > 0 && (
          <ul className="divide-y divide-border border-y border-border">
            {runs.map((run) => (
              <RunRow key={run.id} project={project} run={run} />
            ))}
          </ul>
        )}
        {more && (
          <Button className="mt-4" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show older runs'}
          </Button>
        )}
      </div>
    </section>
  )
}

export function ActivityPage({ name }: { name: string }) {
  return (
    <ProjectLayout name={name} tab="activity">
      {() => <Runs project={name} />}
    </ProjectLayout>
  )
}
