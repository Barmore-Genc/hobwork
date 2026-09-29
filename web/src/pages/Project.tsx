import { useState } from 'react'
import { api, ApiError, type Version } from '../api.ts'
import { exactTime, timeAgo } from '../format.ts'
import { Link } from '../router.tsx'
import { Button, ConfirmDialog, Notice, PageHeading, StatusBadge } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'

function origin(version: Version): string {
  const who = version.by ? ` by ${version.by}` : ''
  if (version.restoredFrom !== null) return `Brought back version ${version.restoredFrom}${who}`
  if (version.number === 1) return `Created${who}`
  return `Changed${who}`
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

export function ProjectPage({ name }: { name: string }) {
  const { data: project, error, reload } = useLoad(() => api.project(name), name)
  const [target, setTarget] = useState<Version | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [result, setResult] = useState<{ from: number; to: number; deployError?: string } | null>(null)

  const current = project?.versions.find((v) => v.number === project.currentVersion) ?? project?.versions[0]

  async function restore() {
    if (!target) return
    setBusy(true)
    setRestoreError(null)
    try {
      const { version, deployError } = await api.restore(name, target.number)
      setResult({ from: target.number, to: version.number, deployError })
      setTarget(null)
      reload()
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Link to="/" className="text-sm text-muted hover:text-fg">
        All projects
      </Link>
      <div className="mt-3">
        <PageHeading aside={project && <StatusBadge status={project.status} />}>{name}</PageHeading>
      </div>

      {error && (
        <div className="mt-8">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {result && (
        <div className="mt-8">
          <Notice tone={result.deployError ? 'error' : 'success'}>
            Version {result.from} is back as version {result.to}.
            {result.deployError && ` It could not be started: ${result.deployError}`}
          </Notice>
        </div>
      )}

      {project && (
        <section className="mt-12" aria-labelledby="versions">
          <h2 id="versions" className="text-2xl font-semibold">
            Versions
          </h2>
          <p className="mt-2 max-w-prose text-muted">
            Each change an agent makes becomes a new version. If something stops working, restore an earlier one.
          </p>
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
        </section>
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
          {name} goes back to how it was in version {target?.number}. This is saved as a new version, so version{' '}
          {current?.number} stays in the list and you can switch back to it at any time.
        </p>
        <p>Data the project has saved stays as it is.</p>
      </ConfirmDialog>
    </div>
  )
}
