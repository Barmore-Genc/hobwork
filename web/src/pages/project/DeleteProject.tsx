import { useState } from 'react'
import { api, ApiError } from '../../api.ts'
import { navigate } from '../../navigation.ts'
import { Button, ConfirmDialog } from '../../ui.tsx'

export function DeleteProjectSection({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await api.deleteProject(name, typed)
      navigate(`/?deleted=${encodeURIComponent(name)}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <section className="mt-16 border-t border-border pt-8" aria-labelledby="delete-project">
      <h2 id="delete-project" className="text-xl font-semibold">
        Delete project
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Removes {name} with its versions, saved data and run history.
      </p>
      <Button
        variant="quiet-danger"
        className="mt-4 -ml-4"
        onClick={() => {
          setTyped('')
          setError(null)
          setOpen(true)
        }}
      >
        Delete {name}
      </Button>

      <ConfirmDialog
        open={open}
        title={`Delete ${name}?`}
        confirmLabel="Delete project"
        variant="danger"
        busy={busy}
        confirmDisabled={typed !== name}
        error={error}
        onConfirm={remove}
        onCancel={() => setOpen(false)}
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>Its schedules, webhooks and Home Assistant triggers stop right away, and its app goes offline.</li>
          <li>Its code, versions, saved data, run history and log are removed from Hobwork.</li>
          <li>Secrets it uses stay on the Secrets page for your other projects.</li>
        </ul>
        <p>
          Hobwork keeps a copy of the code and saved data for 7 days. Whoever runs your Hobwork server can bring it back
          until then.
        </p>
        <label htmlFor="delete-confirm" className="block pt-2 text-fg">
          Type <span className="font-mono font-semibold">{name}</span> to confirm
        </label>
        <input
          id="delete-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed === name && !busy) void remove()
          }}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="min-h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-fg focus:border-danger focus:outline-none"
        />
      </ConfirmDialog>
    </section>
  )
}
