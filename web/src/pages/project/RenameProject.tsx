import { useState } from 'react'
import { api, ApiError } from '../../api.ts'
import { navigate } from '../../navigation.ts'
import { Button, ConfirmDialog } from '../../ui.tsx'
import { PROJECT_NAME_HINT, projectPath, validProjectName } from './names.ts'

export function RenameProjectSection({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = typed.trim()
  const ready = next !== name && validProjectName(next)

  async function rename() {
    setBusy(true)
    setError(null)
    try {
      const renamed = await api.renameProject(name, next)
      navigate(projectPath(renamed.name))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <section className="mt-16 border-t border-border pt-8" aria-labelledby="rename-project">
      <h2 id="rename-project" className="text-xl font-semibold">
        Rename project
      </h2>
      <p className="mt-2 max-w-prose text-muted">The name is part of the app address, webhook URLs and git remote.</p>
      <Button
        className="mt-4"
        onClick={() => {
          setTyped(name)
          setError(null)
          setBusy(false)
          setOpen(true)
        }}
      >
        Rename {name}
      </Button>

      <ConfirmDialog
        open={open}
        title={`Rename ${name}`}
        confirmLabel="Rename project"
        busy={busy}
        confirmDisabled={!ready}
        error={error}
        onConfirm={rename}
        onCancel={() => setOpen(false)}
      >
        <label htmlFor="rename-to" className="block text-fg">
          New name
        </label>
        <input
          id="rename-to"
          value={typed}
          onChange={(e) => setTyped(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready && !busy) void rename()
          }}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-describedby="rename-hint"
          className="min-h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-fg focus:border-accent focus:outline-none"
        />
        <p id="rename-hint" className="text-sm">
          {PROJECT_NAME_HINT}
        </p>
        <ul className="list-disc space-y-1 pt-2 pl-5">
          <li>Anything {name} is running right now is stopped. It starts again under the new name when it is next needed.</li>
          <li>
            Its app address and webhook URLs change to the new name. The old ones keep working until another project
            takes the name.
          </li>
          <li>Agents and git remotes need the new name.</li>
        </ul>
      </ConfirmDialog>
    </section>
  )
}
