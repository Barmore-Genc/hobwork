import { api } from '../../api.ts'
import { duration, exactTime, timeAgo } from '../../format.ts'
import { Link } from '../../router.tsx'
import { Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { LogLines } from './LogLines.tsx'
import { projectPath, KIND_LABELS } from './names.ts'
import { ProjectLayout } from './ProjectLayout.tsx'
import { RunStatus } from './runs.tsx'

function RunDetail({ project, id }: { project: string; id: number }) {
  const { data: run, error } = useLoad(() => api.invocation(project, id), `${project}/${id}`)

  if (error) return <div className="mt-8"><Notice tone="error">{error}</Notice></div>
  if (!run) return null

  const facts: [string, string][] = [
    ['Started', `${exactTime(run.startedAt)}, ${timeAgo(run.startedAt)}`],
    ['Took', run.durationMs === null ? 'Still running' : duration(run.durationMs)],
    ['Started by', `${KIND_LABELS[run.kind]}${run.manual ? ', by an agent' : ''}`],
    ...(run.httpStatus === null ? [] : [['Answered', String(run.httpStatus)] as [string, string]]),
    run.branch !== null
      ? ['Version', `Preview of ${run.branch}`]
      : ['Version', run.version === null ? 'Unknown' : String(run.version)],
  ]

  return (
    <div className="mt-8">
      <Link to={projectPath(project, '/activity')} className="text-sm text-muted hover:text-fg">
        All activity
      </Link>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className={`text-2xl font-semibold break-words ${run.kind === 'route' ? 'font-mono text-xl' : ''}`}>{run.name}</h2>
        <span className="text-[1.05rem]">
          <RunStatus status={run.status} withLabel />
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-6 gap-y-1.5 text-[0.95rem]">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="tabular">{value}</dd>
          </div>
        ))}
      </dl>

      {run.error && (
        <section aria-labelledby="run-error" className="mt-8 rounded-lg border border-danger/40 bg-danger/8 p-4 sm:p-5">
          <h3 id="run-error" className="text-lg font-semibold">
            What went wrong
          </h3>
          <p className="mt-1 break-words">{run.error}</p>
          {run.stack && (
            <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-surface-raised p-3 font-mono text-[0.8rem] leading-relaxed">
              {run.stack}
            </pre>
          )}
        </section>
      )}

      <section aria-labelledby="run-log" className="mt-8">
        <h3 id="run-log" className="text-lg font-semibold">
          Log
        </h3>
        {run.logs.length ? (
          <div className="mt-3">
            <LogLines project={project} lines={run.logs} runLinks={false} />
          </div>
        ) : (
          <p className="mt-1 text-muted">This run wrote nothing to the log.</p>
        )}
      </section>
    </div>
  )
}

export function RunPage({ name, id }: { name: string; id: number }) {
  return (
    <ProjectLayout name={name} tab="activity">
      {() => <RunDetail project={name} id={id} />}
    </ProjectLayout>
  )
}
