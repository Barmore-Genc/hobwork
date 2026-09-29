import { useState } from 'react'
import { api, ApiError, type Branch } from '../../api.ts'
import { exactTime, timeAgo } from '../../format.ts'
import { Link } from '../../router.tsx'
import { ConfirmDialog, Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { previewPath, projectPath } from './names.ts'
import { RunStatus } from './runs.tsx'

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function HomeAssistantSwitch({
  project,
  branch,
  onChange,
}: {
  project: string
  branch: Branch
  onChange: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const allowed = branch.homeAssistant !== null
  const id = `ha-${branch.name}`

  async function change(allow: boolean) {
    setBusy(true)
    setError(null)
    try {
      if (allow) await api.allowBranchHomeAssistant(project, branch.name)
      else await api.stopBranchHomeAssistant(project, branch.name)
      setConfirming(false)
      onChange()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={allowed}
          aria-labelledby={`${id}-label`}
          disabled={busy}
          onClick={() => (allowed ? void change(false) : setConfirming(true))}
          className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60 ${
            allowed ? 'border-accent bg-accent' : 'border-border bg-surface-raised'
          }`}
        >
          <span
            aria-hidden="true"
            className={`size-4.5 rounded-full shadow-sm transition-transform motion-reduce:transition-none ${
              allowed ? 'translate-x-5.5 bg-on-accent' : 'translate-x-0.5 bg-muted'
            }`}
          />
        </button>
        <div className="min-w-0 text-sm">
          <p id={`${id}-label`} className="font-semibold text-fg">
            Let this branch control Home Assistant
          </p>
          <p className="text-muted">
            {branch.homeAssistant ? (
              <>
                Allowed by {branch.homeAssistant.by},{' '}
                <time dateTime={branch.homeAssistant.grantedAt} title={exactTime(branch.homeAssistant.grantedAt)}>
                  {timeAgo(branch.homeAssistant.grantedAt)}
                </time>
              </>
            ) : (
              'It can see what is happening at home, but not switch anything.'
            )}
          </p>
        </div>
      </div>
      {error && !confirming && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Let ${branch.name} control Home Assistant?`}
        confirmLabel="Allow"
        busy={busy}
        error={error}
        onConfirm={() => change(true)}
        onCancel={() => setConfirming(false)}
      >
        <p>
          While you try out this branch, it can turn things on and off at home and send events, like the live version does.
          Changes on this branch have not been checked yet.
        </p>
        <p>You can turn this off again at any time.</p>
      </ConfirmDialog>
    </div>
  )
}

function BranchRow({ project, branch, onChange }: { project: string; branch: Branch; onChange: () => void }) {
  const [latest] = branch.recentRuns
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="font-semibold break-all">{branch.name}</p>
          <p className="text-sm break-words text-muted">
            {branch.head.subject},{' '}
            <time dateTime={branch.head.updatedAt} title={exactTime(branch.head.updatedAt)}>
              {timeAgo(branch.head.updatedAt)}
            </time>
          </p>
          {latest ? (
            <Link
              to={`${projectPath(project, '/activity')}?branch=${encodeURIComponent(branch.name)}`}
              className="mt-1 inline-flex items-center gap-2 text-sm text-muted hover:text-fg"
            >
              <span className="inline-flex gap-1">
                {branch.recentRuns.map((run) => (
                  <RunStatus key={run.id} status={run.status} />
                ))}
              </span>
              Last tried {timeAgo(latest.startedAt)}
            </Link>
          ) : (
            <p className="mt-1 text-sm text-muted">Not tried yet</p>
          )}
        </div>
        {branch.previewUrl && (
          <Link
            to={previewPath(project, branch.name)}
            className="inline-flex min-h-10 items-center rounded-md border border-border bg-surface-raised px-4 text-[0.95rem] font-semibold hover:border-muted"
          >
            Preview
          </Link>
        )}
      </div>
      <HomeAssistantSwitch project={project} branch={branch} onChange={onChange} />
    </li>
  )
}

export function BranchesSection({ project }: { project: string }) {
  const { data: branches, error, reload } = useLoad(() => api.branches(project), project)
  if (!branches?.length && !error) return null
  return (
    <section className="mt-12" aria-labelledby="branches">
      <h2 id="branches" className="text-2xl font-semibold">
        Changes in progress
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Agents work on changes in branches. Try one out before it goes live. It uses its own copy of the saved data.
      </p>
      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {branches && (
        <ul className="mt-4 divide-y divide-border border-y border-border">
          {branches.map((branch) => (
            <BranchRow key={branch.name} project={project} branch={branch} onChange={reload} />
          ))}
        </ul>
      )}
    </section>
  )
}

export function PreviewPage({ name, branch }: { name: string; branch: string }) {
  const { data: branches, error } = useLoad(() => api.branches(name), name)
  const found = branches?.find((b) => b.name === branch)
  return (
    <div>
      <Link to={projectPath(name)} className="text-sm text-muted hover:text-fg">
        {name}
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <h1 className="text-[2.1rem] leading-tight font-semibold tracking-[-0.01em] break-all sm:text-[2.6rem]">{branch}</h1>
        {found?.previewUrl && (
          <a
            href={found.previewUrl}
            target="_blank"
            rel="noopener"
            className="text-sm text-muted underline decoration-border underline-offset-4 hover:text-fg"
          >
            Open in a new tab
          </a>
        )}
      </div>
      <p className="mt-1 text-muted">A preview of this change, with its own copy of the saved data.</p>
      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {branches && !found && <p className="mt-8 text-muted">This branch no longer exists. It may have gone live already.</p>}
      {found && !found.previewUrl && <p className="mt-8 text-muted">This branch cannot be previewed.</p>}
      {found?.previewUrl && (
        <iframe
          src={found.previewUrl}
          title={`Preview of ${branch}`}
          className="mt-6 block h-[calc(100dvh-15rem)] min-h-[28rem] w-full rounded-lg border border-border bg-bg"
        />
      )}
      {found && (
        <div className="mt-4">
          <Link
            to={`${projectPath(name, '/activity')}?branch=${encodeURIComponent(branch)}`}
            className="text-sm text-muted underline decoration-border underline-offset-4 hover:text-fg"
          >
            See what it ran
          </Link>
        </div>
      )}
    </div>
  )
}
