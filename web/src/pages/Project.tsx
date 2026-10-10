import { useState, type ReactNode } from 'react'
import { api, ApiError, type EntryPoints, type LastRun, type ProjectDetail, type Version } from '../api.ts'
import { bytes, dayTime, exactTime, shortDate, timeAgo } from '../format.ts'
import { kindChanged } from '../live.ts'
import { Link } from '../router.tsx'
import { Button, ConfirmDialog, Notice } from '../ui.tsx'
import { usePaged } from '../usePaged.ts'
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

function InstallScriptFlag({ installScripts }: { installScripts: Version['installScripts'] }) {
  const { added, removed } = installScripts
  if (!added.length && !removed.length) return null
  return (
    <div className="mt-3 max-w-prose rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-sm">
      <p className="font-semibold">Changed which packages can run code when installed</p>
      {added.length > 0 && (
        <p className="mt-1 text-muted">
          Now allowed: <span className="font-mono text-fg">{added.join(', ')}</span>
        </p>
      )}
      {removed.length > 0 && (
        <p className="mt-1 text-muted">
          No longer allowed: <span className="font-mono text-fg">{removed.join(', ')}</span>
        </p>
      )}
    </div>
  )
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
        <InstallScriptFlag installScripts={version.installScripts} />
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
  if (trigger.upload) return `When a file arrives through ${trigger.upload}`
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

function uploadSummary(upload: EntryPoints['uploads'][number]): string {
  const kinds = upload.types.length ? `, only ${upload.types.join(', ')}` : ''
  return `Into ${upload.prefix}, files up to ${bytes(upload.maxBytes)}${kinds}`
}

function NewUploadToken({ token, url, onDone }: { token: string; url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const command = `curl -T <file> -H "Authorization: Bearer ${token}" ${url}<file name>`
  return (
    <div className="mt-3 rounded-lg border-2 border-accent bg-surface-raised p-4">
      <p className="font-semibold">New upload token</p>
      <p className="mt-1 text-sm text-muted">Copy it now. Hobwork shows it only once. A script sends each file like this:</p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <code className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2.5 font-mono text-sm break-all select-all">
          {command}
        </code>
        <Button
          variant="primary"
          onClick={async () => {
            await navigator.clipboard.writeText(token)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy token'}
        </Button>
      </div>
      <Button variant="quiet" className="mt-3" onClick={onDone}>
        I saved the token
      </Button>
    </div>
  )
}

function UploadsGroup({ project, reload }: { project: ProjectDetail; reload: () => void }) {
  const [replacing, setReplacing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ name: string; error: string } | null>(null)
  const [created, setCreated] = useState<{ name: string; token: string; url: string } | null>(null)
  const uploads = project.entryPoints?.uploads ?? []

  async function rotate(name: string) {
    setBusy(true)
    setFailed(null)
    try {
      const { token, url } = await api.rotateUploadToken(project.name, name)
      setCreated({ name, token, url })
      setReplacing(null)
      reload()
    } catch (err) {
      setFailed({ name, error: message(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <EntryGroup title="Uploads" description="Take files from the hob's app, and from scripts with a token.">
        {uploads.map((upload) => (
          <li key={upload.name} className="py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <div className="min-w-0">
                <p className="font-semibold break-words">{upload.name}</p>
                <p className="text-sm break-words text-muted">{uploadSummary(upload)}</p>
                <p className="text-sm text-muted">
                  {upload.tokenCreatedAt ? (
                    <span title={exactTime(upload.tokenCreatedAt)}>Token created {shortDate(upload.tokenCreatedAt)}</span>
                  ) : (
                    'No token yet, so only the app can upload'
                  )}
                </p>
              </div>
              <Button
                onClick={() => {
                  setFailed(null)
                  if (upload.tokenCreatedAt) setReplacing(upload.name)
                  else void rotate(upload.name)
                }}
                disabled={busy}
              >
                {upload.tokenCreatedAt ? 'Replace token' : 'Create token'}
              </Button>
            </div>
            {created?.name === upload.name && <NewUploadToken token={created.token} url={created.url} onDone={() => setCreated(null)} />}
            {failed?.name === upload.name && replacing === null && (
              <div className="mt-3">
                <Notice tone="error">{failed.error}</Notice>
              </div>
            )}
          </li>
        ))}
      </EntryGroup>
      <ConfirmDialog
        open={replacing !== null}
        title={`Replace the upload token of ${replacing}?`}
        confirmLabel="Replace token"
        variant="danger"
        busy={busy}
        error={failed?.name === replacing ? failed.error : null}
        onConfirm={() => replacing && rotate(replacing)}
        onCancel={() => setReplacing(null)}
      >
        <p>The current token stops working right away. Scripts that use it need the new one.</p>
      </ConfirmDialog>
    </>
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
    !entries.triggers.length &&
    !entries.uploads.length

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
                    {cron.timeZone === 'person' ? (
                      "Runs for each person in their own time zone"
                    ) : cron.nextRun ? (
                      <>
                        Next run <span title={exactTime(cron.nextRun)}>{dayTime(cron.nextRun)}</span>,{' '}
                        {timeAgo(cron.nextRun)}
                      </>
                    ) : (
                      'Never runs'
                    )}
                    <span className="ml-2 font-mono text-[0.8rem]">{cron.schedule}</span>
                    {cron.timeZone && cron.timeZone !== 'person' && <span className="ml-2 text-[0.8rem]">{cron.timeZone}</span>}
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
          {entries.uploads.length > 0 && <UploadsGroup project={project} reload={reload} />}
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
            <>
              <ul className="flex flex-wrap gap-2">
                {project.egress.map(({ target, private: home, allowed }) => (
                  <li
                    key={target}
                    title={home ? (allowed ? 'On your home network' : 'On your home network, and this server does not allow it') : undefined}
                    className={`rounded-sm border px-2 py-0.5 text-sm break-all ${allowed ? 'border-border' : 'border-danger/40 text-muted'} bg-surface`}
                  >
                    <span className={`font-mono ${allowed ? '' : 'line-through'}`}>{target}</span>
                    {home && <span className="ml-1.5 text-xs text-muted">{allowed ? 'home network' : 'blocked'}</span>}
                  </li>
                ))}
              </ul>
              {project.egress.some((entry) => !entry.allowed) && (
                <p className="mt-2 text-sm text-muted">
                  Crossed-out addresses are on your home network, and this server does not let hobs reach them. Whoever runs Hobwork can allow them.
                </p>
              )}
            </>
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
  const {
    items: versions,
    more,
    error,
    loadingMore,
    loadMore,
  } = usePaged<Version>({
    load: (oldest) => api.versions(project.name, oldest?.number).then((page) => ({ items: page.versions, more: page.more })),
    key: project.name,
    isOlder: (version, than) => version.number < than.number,
    live: kindChanged('project', project.name),
  })
  const current = project.currentVersion ?? versions?.[0]?.number

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
      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <ol className="mt-8">
        {versions?.map((version) => (
          <VersionRow
            key={version.number}
            version={version}
            current={version.number === current}
            onRestore={(v) => {
              setRestoreError(null)
              setTarget(v)
            }}
          />
        ))}
      </ol>
      {more && (
        <Button onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show older versions'}
        </Button>
      )}

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
          {current} stays in the list and you can switch back to it at any time.
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
