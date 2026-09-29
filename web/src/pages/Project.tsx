import { useState, type ReactNode } from 'react'
import { api, ApiError, type EntryPoints, type LastRun, type ProjectDetail, type Version } from '../api.ts'
import { bytes, dayTime, exactTime, shortDate, timeAgo } from '../format.ts'
import { Link } from '../router.tsx'
import { Button, ConfirmDialog, Notice } from '../ui.tsx'
import { DeleteProjectSection } from './project/DeleteProject.tsx'
import { RenameProjectSection } from './project/RenameProject.tsx'
import { BranchesSection } from './project/Branches.tsx'
import { projectPath } from './project/names.ts'
import { ProjectLayout } from './project/ProjectLayout.tsx'
import { RunStatus } from './project/runs.tsx'

function origin(version: Version): string {
  const who = version.by ? ` by ${version.by}` : ''
  if (version.restoredFrom !== null) return `Brought back version ${version.restoredFrom}${who}`
  if (version.number === 1) return `Created${who}`
  return `Changed${who}`
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function VersionRow({
  version,
  current,
  onRestore,
}: {
  version: Version
  current: boolean
  onRestore: (version: Version) => void
}) {
  return (
    <li className="relative grid grid-cols-[3.5rem_1fr] gap-x-4 sm:grid-cols-[4.5rem_1fr_auto] sm:gap-x-6">
      <div className="relative flex justify-end pt-0.5">
        <span
          className={`font-display text-[2rem] leading-none font-semibold tabular sm:text-[2.5rem] ${
            current ? 'text-accent-fg' : 'text-muted/70'
          }`}
          aria-label={`Version ${version.number}`}
        >
          {version.number}
        </span>
      </div>
      <div className={`min-w-0 border-l-2 pb-8 pl-5 ${current ? 'border-accent' : 'border-border'}`}>
        {current && (
          <p className="mb-1 inline-flex items-center gap-2 text-sm font-semibold text-accent-fg">In use now</p>
        )}
        <p className="text-[1.05rem] leading-snug font-semibold break-words">{version.summary}</p>
        <p className="mt-1 text-sm text-muted">
          {origin(version)}, <time dateTime={version.createdAt} title={exactTime(version.createdAt)}>{timeAgo(version.createdAt)}</time>
        </p>
        {!current && (
          <div className="mt-3 sm:hidden">
            <Button onClick={() => onRestore(version)}>Restore this version</Button>
          </div>
        )}
      </div>
      <div className="hidden sm:block">
        {!current && <Button onClick={() => onRestore(version)}>Restore this version</Button>}
      </div>
    </li>
  )
}

function LastRunLink({ project, run }: { project: string; run: LastRun }) {
  if (!run) return <span className="text-sm text-muted">Has not run yet</span>
  return (
    <Link
      to={projectPath(project, `/activity/${run.id}`)}
      className="inline-flex items-center gap-2 text-sm text-muted hover:text-fg"
      title={exactTime(run.startedAt)}
    >
      <RunStatus status={run.status} />
      {run.status === 'error' ? 'Failed' : run.status === 'running' ? 'Running since' : 'Ran'} {timeAgo(run.startedAt)}
    </Link>
  )
}

function EntryGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-sm text-muted">{description}</p>
      <ul className="mt-2 divide-y divide-border border-y border-border">{children}</ul>
    </div>
  )
}

function EntryRow({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
      <div className="min-w-0">{children}</div>
      <div className="flex flex-wrap items-center gap-3">{aside}</div>
    </li>
  )
}

function triggerSummary(trigger: EntryPoints['triggers'][number]): string {
  if (trigger.device) {
    const on = trigger.device.device ? ` on ${trigger.device.device}` : ''
    const summaries: Record<string, string> = {
      notifications: `When someone taps a button on a notification from this hob${on}`,
      focus: `When a Focus mode turns on or off${on}`,
      nfc: trigger.device.url
        ? `When someone scans an NFC tag with a link starting with ${trigger.device.url}${on}`
        : `When someone scans an NFC tag of this hob${on}`,
      health: `When new Health data arrives${on}`,
    }
    return summaries[trigger.device.capability] ?? 'On a device event'
  }
  const definition = trigger.homeassistant
  if (!definition) return 'From another integration'
  const words = (value: unknown) => String(value).replaceAll('_', ' ')
  const kind = String(definition.trigger ?? definition.platform ?? '')
  if (kind === 'device' && definition.type) {
    return `When a device reports ${words(definition.type)}${definition.subtype ? ` (${words(definition.subtype)})` : ''}`
  }
  if (kind === 'state' && definition.entity_id) return `When ${String(definition.entity_id)} changes`
  if (kind === 'event' && definition.event_type) return `When the ${String(definition.event_type)} event happens`
  return kind ? `On a ${words(kind)} trigger` : 'On a Home Assistant trigger'
}

function NewWebhookUrl({ name, url, onDone }: { name: string; url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-3 rounded-lg border-2 border-accent bg-surface-raised p-4">
      <p className="font-semibold">New URL for {name}</p>
      <p className="mt-1 text-sm text-muted">Copy it now. Hobwork shows it only once.</p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <code className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2.5 font-mono text-sm break-all select-all">
          {url}
        </code>
        <Button
          variant="primary"
          onClick={async () => {
            await navigator.clipboard.writeText(url)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy URL'}
        </Button>
      </div>
      <Button variant="quiet" className="mt-3" onClick={onDone}>
        I saved the URL
      </Button>
    </div>
  )
}

function EntryPointsSection({ project, reload }: { project: ProjectDetail; reload: () => void }) {
  const [replacing, setReplacing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ name: string; error: string } | null>(null)
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null)
  const entries = project.entryPoints

  async function rotate(name: string) {
    setBusy(true)
    setFailed(null)
    try {
      const { url } = await api.rotateWebhook(project.name, name)
      setCreated({ name, url })
      setReplacing(null)
      reload()
    } catch (err) {
      setFailed({ name, error: message(err) })
    } finally {
      setBusy(false)
    }
  }

  const empty =
    entries &&
    !entries.crons.length &&
    !entries.routes.length &&
    !entries.webhooks.length &&
    !entries.triggers.length

  return (
    <section className="mt-10" aria-labelledby="entry-points">
      <h2 id="entry-points" className="text-2xl font-semibold">
        What it does
      </h2>
      {project.configError && (
        <div className="mt-4">
          <Notice tone="error">{project.configError}</Notice>
        </div>
      )}
      {empty && <p className="mt-2 text-muted">Nothing runs in this hob yet.</p>}
      {entries && !empty && (
        <div className="mt-6 space-y-8">
          {entries.crons.length > 0 && (
            <EntryGroup title="Schedules" description="Run at set times.">
              {entries.crons.map((cron) => (
                <EntryRow key={cron.name} aside={<LastRunLink project={project.name} run={cron.lastRun} />}>
                  <p className="font-semibold break-words">{cron.name}</p>
                  <p className="text-sm text-muted">
                    {cron.nextRun ? (
                      <>
                        Next run <span title={exactTime(cron.nextRun)}>{dayTime(cron.nextRun)}</span>,{' '}
                        {timeAgo(cron.nextRun)}
                      </>
                    ) : (
                      'Never runs'
                    )}
                    <span className="ml-2 font-mono text-[0.8rem]">{cron.schedule}</span>
                  </p>
                </EntryRow>
              ))}
            </EntryGroup>
          )}
          {entries.triggers.length > 0 && (
            <EntryGroup title="Triggers" description="Run when something happens at home or on your devices.">
              {entries.triggers.map((trigger) => (
                <EntryRow key={trigger.name} aside={<LastRunLink project={project.name} run={trigger.lastRun} />}>
                  <p className="font-semibold break-words">{trigger.name}</p>
                  <p className="text-sm break-words text-muted">{triggerSummary(trigger)}</p>
                </EntryRow>
              ))}
            </EntryGroup>
          )}
          {entries.webhooks.length > 0 && (
            <EntryGroup title="Webhooks" description="Run when another service calls their private URL.">
              {entries.webhooks.map((hook) => (
                <li key={hook.name} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                    <div className="min-w-0">
                      <p className="font-semibold break-words">{hook.name}</p>
                      <p className="text-sm text-muted">
                        {hook.tokenCreatedAt ? (
                          <span title={exactTime(hook.tokenCreatedAt)}>URL created {shortDate(hook.tokenCreatedAt)}</span>
                        ) : (
                          'No URL yet, so nothing can call it'
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <LastRunLink project={project.name} run={hook.lastRun} />
                      <Button
                        onClick={() => {
                          setFailed(null)
                          if (hook.tokenCreatedAt) setReplacing(hook.name)
                          else void rotate(hook.name)
                        }}
                        disabled={busy}
                      >
                        {hook.tokenCreatedAt ? 'Replace URL' : 'Create URL'}
                      </Button>
                    </div>
                  </div>
                  {created?.name === hook.name && (
                    <NewWebhookUrl name={hook.name} url={created.url} onDone={() => setCreated(null)} />
                  )}
                  {failed?.name === hook.name && replacing === null && (
                    <div className="mt-3">
                      <Notice tone="error">{failed.error}</Notice>
                    </div>
                  )}
                </li>
              ))}
            </EntryGroup>
          )}
          {entries.routes.length > 0 && (
            <EntryGroup title="App requests" description="Answer the hob's app and agents.">
              {entries.routes.map((route) => (
                <EntryRow key={route.key} aside={<LastRunLink project={project.name} run={route.lastRun} />}>
                  <p className="font-mono text-sm break-all">{route.key}</p>
                </EntryRow>
              ))}
            </EntryGroup>
          )}
        </div>
      )}

      <ConfirmDialog
        open={replacing !== null}
        title={`Replace the URL of ${replacing}?`}
        confirmLabel="Replace URL"
        variant="danger"
        busy={busy}
        error={failed?.name === replacing ? failed.error : null}
        onConfirm={() => replacing && rotate(replacing)}
        onCancel={() => setReplacing(null)}
      >
        <p>The current URL stops working right away. Anything that calls it needs the new one.</p>
      </ConfirmDialog>
    </section>
  )
}

function HealthSection({ project }: { project: ProjectDetail }) {
  const db = project.database
  return (
    <section className="mt-12" aria-labelledby="health">
      <h2 id="health" className="text-2xl font-semibold">
        Data and network
      </h2>
      <dl className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-[10rem_1fr]">
        {db && (
          <>
            <dt className="font-semibold">Saved data</dt>
            <dd className="min-w-0 space-y-2">
              <p>{db.sizeBytes ? bytes(db.sizeBytes) : 'Nothing saved yet'}</p>
              {db.sizeWarning && <Notice tone="error">{db.sizeWarning}</Notice>}
              {db.slowQueries.count > 0 && (
                <p className="text-sm text-muted">
                  {db.slowQueries.count === 1 ? '1 slow lookup' : `${db.slowQueries.count} slow lookups`}, the slowest took{' '}
                  {(db.slowQueries.slowestMs / 1000).toFixed(1)} s
                </p>
              )}
            </dd>
          </>
        )}
        <dt className="font-semibold">Can reach</dt>
        <dd className="min-w-0">
          {project.egress.length ? (
            <ul className="flex flex-wrap gap-2">
              {project.egress.map((host) => (
                <li key={host} className="rounded-sm border border-border bg-surface px-2 py-0.5 font-mono text-sm break-all">
                  {host}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No sites on the internet</p>
          )}
        </dd>
      </dl>
    </section>
  )
}

function VersionsSection({ project, reload }: { project: ProjectDetail; reload: () => void }) {
  const [target, setTarget] = useState<Version | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [result, setResult] = useState<{ from: number; to: number; deployError?: string } | null>(null)
  const current = project.versions.find((v) => v.number === project.currentVersion) ?? project.versions[0]

  async function restore() {
    if (!target) return
    setBusy(true)
    setRestoreError(null)
    try {
      const { version, deployError } = await api.restore(project.name, target.number)
      setResult({ from: target.number, to: version.number, deployError })
      setTarget(null)
      reload()
    } catch (err) {
      setRestoreError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-12" aria-labelledby="versions">
      <h2 id="versions" className="text-2xl font-semibold">
        Versions
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Each change an agent makes becomes a new version. If something stops working, restore an earlier one.
      </p>
      {result && (
        <div className="mt-6">
          <Notice tone={result.deployError ? 'error' : 'success'}>
            Version {result.from} is back as version {result.to}.
            {result.deployError && ` It could not be started: ${result.deployError}`}
          </Notice>
        </div>
      )}
      <ol className="mt-8">
        {project.versions.map((version) => (
          <VersionRow
            key={version.number}
            version={version}
            current={version.number === current?.number}
            onRestore={(v) => {
              setRestoreError(null)
              setTarget(v)
            }}
          />
        ))}
      </ol>

      <ConfirmDialog
        open={target !== null}
        title={`Restore version ${target?.number}?`}
        confirmLabel={`Restore version ${target?.number}`}
        busy={busy}
        error={restoreError}
        onConfirm={restore}
        onCancel={() => setTarget(null)}
      >
        <p>
          {project.name} goes back to how it was in version {target?.number}. This is saved as a new version, so version{' '}
          {current?.number} stays in the list and you can switch back to it at any time.
        </p>
        <p>Data the hob has saved stays as it is.</p>
      </ConfirmDialog>
    </section>
  )
}

export function ProjectPage({ name }: { name: string }) {
  return (
    <ProjectLayout name={name} tab="overview">
      {(project, reload) => (
        <>
          <EntryPointsSection project={project} reload={reload} />
          <BranchesSection project={project.name} />
          <HealthSection project={project} />
          <VersionsSection project={project} reload={reload} />
          <RenameProjectSection name={project.name} />
          <DeleteProjectSection name={project.name} />
        </>
      )}
    </ProjectLayout>
  )
}
