import { useState } from 'react'
import { api, ApiError, type DeletedProject } from '../api.ts'
import { exactTime, shortDate, timeAgo } from '../format.ts'
import { navigate } from '../navigation.ts'
import { Link } from '../router.tsx'
import { Button, ConfirmDialog, Notice, PageHeading } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'
import { PROJECT_NAME_HINT, projectPath, validProjectName } from './project/names.ts'

export function DeletedProjectsPage() {
  const { data, error } = useLoad(api.deletedProjects)
  const [target, setTarget] = useState<DeletedProject | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const trimmed = name.trim()

  function open(entry: DeletedProject) {
    setTarget(entry)
    setName(entry.nameTaken ? '' : entry.project)
    setRestoreError(null)
    setBusy(false)
  }

  async function restore() {
    if (!target) return
    setBusy(true)
    setRestoreError(null)
    try {
      const restored = await api.restoreDeletedProject(target.id, trimmed)
      navigate(projectPath(restored.name))
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div>
      <Link to="/" className="text-sm text-muted hover:text-fg">
        All hobs
      </Link>
      <div className="mt-3">
        <PageHeading>Deleted hobs</PageHeading>
      </div>
      <p className="mt-3 max-w-prose text-muted">
        Deleted hobs are kept for {data?.trashDays ?? 7} days. Restoring one brings back its code, versions, saved
        data, secrets and webhooks. Its run history and log stay deleted.
      </p>

      <div className="mt-10 space-y-6">
        {error && <Notice tone="error">{error}</Notice>}
        {data?.projects.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-6 py-10">
            <h2 className="text-xl font-semibold">Nothing deleted</h2>
            <p className="mt-2 max-w-prose text-muted">Hobs you delete show up here until they are removed for good.</p>
          </div>
        )}
        {data && data.projects.length > 0 && (
          <ul className="divide-y divide-border border-y border-border">
            {data.projects.map((entry) => (
              <li key={entry.id} className="grid gap-x-6 gap-y-3 px-1 py-5 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <h2 className="text-[1.45rem] leading-snug font-semibold tracking-[-0.01em]">{entry.project}</h2>
                  {entry.lastVersion && (
                    <p className="mt-1 truncate text-muted">
                      Version {entry.lastVersion.number}: {entry.lastVersion.summary}
                    </p>
                  )}
                  <p className="mt-1 text-sm text-muted">
                    <span title={exactTime(entry.deletedAt)}>
                      Deleted {timeAgo(entry.deletedAt)}
                      {entry.deletedBy && ` by ${entry.deletedBy}`}
                    </span>
                    . <span title={exactTime(entry.purgeAfter)}>Removed for good on {shortDate(entry.purgeAfter)}.</span>
                  </p>
                </div>
                <Button onClick={() => open(entry)} className="justify-self-start sm:justify-self-end">
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={target !== null}
        title={`Restore ${target?.project}?`}
        confirmLabel="Restore hob"
        busy={busy}
        confirmDisabled={!validProjectName(trimmed)}
        error={restoreError}
        onConfirm={restore}
        onCancel={() => setTarget(null)}
      >
        {target?.nameTaken && <p>Another hob is called {target.project} now. Pick a name for this one.</p>}
        <label htmlFor="restore-name" className="block pt-1 text-fg">
          Name
        </label>
        <input
          id="restore-name"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && validProjectName(trimmed) && !busy) void restore()
          }}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-describedby="restore-hint"
          className="min-h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-fg focus:border-accent focus:outline-none"
        />
        <p id="restore-hint" className="text-sm">
          {PROJECT_NAME_HINT}
        </p>
        <p className="pt-2">
          Its schedules, webhooks and Home Assistant triggers work again right away, on the version it had when it was
          deleted.
</p>
      </ConfirmDialog>
    </div>
  )
}
