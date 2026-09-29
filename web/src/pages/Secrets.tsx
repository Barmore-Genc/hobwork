import { useState, type FormEvent } from 'react'
import { api, ApiError, type Secret } from '../api.ts'
import { exactTime, timeAgo } from '../format.ts'
import { Link } from '../router.tsx'
import { Button, ConfirmDialog, Notice, PageHeading } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'
import { ProjectLayout } from './project/ProjectLayout.tsx'

const inputClass =
  'min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none'

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function parseHosts(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

// Creates a secret, or changes one when `existing` is set. The value field
// starts empty: saved values are never shown again.
function SecretForm({
  project,
  existing,
  onSaved,
  onCancel,
}: {
  project: string | null
  existing?: Secret
  onSaved: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [value, setValue] = useState('')
  const [hosts, setHosts] = useState(existing?.hosts.join(', ') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = existing ? `secret-${existing.name}` : 'secret-new'

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.saveSecret(project, name.trim(), { ...(value ? { value } : {}), hosts: parseHosts(hosts) })
      onSaved(name.trim())
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="rounded-lg border border-border bg-surface p-5 sm:p-6">
      <h2 className="text-lg font-semibold">{existing ? `Change ${existing.name}` : 'Add a secret'}</h2>
      <div className="mt-4 space-y-4">
        {!existing && (
          <div>
            <label htmlFor={`${id}-name`} className="font-semibold">
              Name
            </label>
            <p className="text-sm text-muted">Capital letters, digits and underscores. Use the name your agent asked for.</p>
            <input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[\s-]/g, '_'))}
              placeholder="SPOOL_API_KEY"
              required
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              className={`${inputClass} mt-2 font-mono`}
            />
          </div>
        )}
        <div>
          <label htmlFor={`${id}-value`} className="font-semibold">
            {existing ? 'New value' : 'Value'}
          </label>
          <p className="text-sm text-muted">
            {existing ? 'Leave it empty to keep the current value.' : 'Once saved, it cannot be viewed again. You can replace it.'}
          </p>
          <input
            id={`${id}-value`}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required={!existing}
            autoComplete="new-password"
            spellCheck={false}
            className={`${inputClass} mt-2 font-mono`}
          />
        </div>
        <div>
          <label htmlFor={`${id}-hosts`} className="font-semibold">
            Sites it may be sent to
          </label>
          <p className="text-sm text-muted">
            Separate them with commas. <span className="font-mono">*.example.com</span> covers every site under
            example.com.
          </p>
          <input
            id={`${id}-hosts`}
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder="api.example.com"
            required
            autoComplete="off"
            spellCheck={false}
            className={`${inputClass} mt-2 font-mono`}
          />
        </div>
      </div>
      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <Button variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Add secret'}
        </Button>
      </div>
    </form>
  )
}

function SecretRow({
  secret,
  editable,
  onChange,
  onDelete,
}: {
  secret: Secret
  editable: boolean
  onChange: () => void
  onDelete: () => void
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-4">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono font-semibold break-all">{secret.name}</span>
          {!editable && (
            <Link
              to="/secrets"
              className="rounded-sm bg-surface px-1.5 text-sm text-muted ring-1 ring-border hover:text-fg"
              title="Change it on the Shared secrets page"
            >
              Shared with all projects
            </Link>
          )}
        </p>
        <ul className="mt-2 flex flex-wrap gap-2" aria-label={`Sites ${secret.name} may be sent to`}>
          {secret.hosts.map((host) => (
            <li key={host} className="rounded-sm border border-border bg-surface px-2 py-0.5 font-mono text-sm break-all">
              {host}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-muted">
          <span title={exactTime(secret.updatedAt)}>
            {secret.updatedAt === secret.createdAt ? 'Added' : 'Changed'} {timeAgo(secret.updatedAt)}
          </span>
        </p>
      </div>
      {editable && (
        <div className="flex gap-2">
          <Button onClick={onChange}>Change</Button>
          <Button variant="quiet-danger" onClick={onDelete}>
            Delete
          </Button>
        </div>
      )}
    </li>
  )
}

// Without a project: the secrets every project gets.
function SecretsManager({ project }: { project: string | null }) {
  const { data: secrets, error, reload } = useLoad(() => api.secrets(project), project ?? '')
  const [editing, setEditing] = useState<Secret | 'new' | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Secret | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function remove() {
    if (!deleting) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await api.deleteSecret(project, deleting.name)
      setDeleting(null)
      setSaved(null)
      reload()
    } catch (err) {
      setDeleteError(message(err))
    } finally {
      setDeleteBusy(false)
    }
  }

  const done = (name: string) => {
    setEditing(null)
    setSaved(name)
    reload()
  }

  return (
    <div className="mt-8 space-y-6">
      {editing === 'new' ? (
        <SecretForm project={project} onSaved={done} onCancel={() => setEditing(null)} />
      ) : (
        <Button
          variant="primary"
          onClick={() => {
            setSaved(null)
            setEditing('new')
          }}
        >
          Add a secret
        </Button>
      )}
      {saved && <Notice tone="success">Saved {saved}.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {secrets?.length === 0 && (
        <p className="text-muted">{project ? `${project} has no secrets yet.` : 'No shared secrets yet.'}</p>
      )}
      {secrets && secrets.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {secrets.map((secret) =>
            editing !== 'new' && editing?.name === secret.name ? (
              <li key={secret.name} className="py-4">
                <SecretForm project={project} existing={secret} onSaved={done} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <SecretRow
                key={secret.name}
                secret={secret}
                editable={project === null || secret.scope === 'project'}
                onChange={() => {
                  setSaved(null)
                  setEditing(secret)
                }}
                onDelete={() => {
                  setDeleteError(null)
                  setDeleting(secret)
                }}
              />
            ),
          )}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name}?`}
        confirmLabel="Delete secret"
        variant="danger"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      >
        <p>
          {project
            ? `${project} can no longer use it. Anything that needs it stops working until you add it again.`
            : 'No project can use it anymore. Anything that needs it stops working until you add it again.'}
        </p>
      </ConfirmDialog>
    </div>
  )
}

export function ProjectSecretsPage({ name }: { name: string }) {
  return (
    <ProjectLayout name={name} tab="secrets">
      {() => (
        <>
          <p className="mt-8 max-w-prose text-muted">
            Passwords and keys {name} uses to sign in to other services. Each one is only sent to the sites listed with
            it. Secrets shared with all projects are listed here too.
          </p>
          <SecretsManager project={name} />
        </>
      )}
    </ProjectLayout>
  )
}

export function SharedSecretsPage() {
  return (
    <div>
      <PageHeading>Shared secrets</PageHeading>
      <p className="mt-3 max-w-prose text-muted">
        Passwords and keys every project can use. Each one is only sent to the sites listed with it. A project secret
        with the same name replaces the shared one in that project.
      </p>
      <SecretsManager project={null} />
    </div>
  )
}
