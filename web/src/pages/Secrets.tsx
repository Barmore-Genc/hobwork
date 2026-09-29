import { useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError, type ChangedBy, type ProjectSecret, type Secret } from '../api.ts'
import { exactTime, timeAgo } from '../format.ts'
import { Link } from '../router.tsx'
import { Button, ConfirmDialog, Notice, PageHeading } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'
import { projectPath } from './project/names.ts'
import { ProjectLayout } from './project/ProjectLayout.tsx'

const inputClass =
  'min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none'

const MAX_ENV_NAME = 64

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function parseHosts(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

// "Spoolman API key" becomes SPOOLMAN_API_KEY.
function defaultEnvName(name: string): string {
  const env = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  return (/^[0-9]/.test(env) ? `_${env}` : env).slice(0, MAX_ENV_NAME)
}

function cleanEnvName(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, '_')
}

function byText(by: ChangedBy): string {
  if (!by) return ''
  return by.kind === 'agent' ? ` by agent ${by.name}` : ` by ${by.name}`
}

function When({ iso, children }: { iso: string; children: ReactNode }) {
  return <span title={exactTime(iso)}>{children}</span>
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: ReactNode
  children: (id: string) => ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      {hint && <p className="text-sm text-muted">{hint}</p>}
      <div className="mt-2">{children(id)}</div>
    </div>
  )
}

function EnvNameField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field id={id} label="Name in the project" hint="The name the project's code uses for it. Use the one your agent asked for.">
      {(fieldId) => (
        <input
          id={fieldId}
          value={value}
          onChange={(e) => onChange(cleanEnvName(e.target.value))}
          placeholder="SPOOLMAN_TOKEN"
          required
          maxLength={MAX_ENV_NAME}
          autoComplete="off"
          spellCheck={false}
          className={`${inputClass} font-mono`}
        />
      )}
    </Field>
  )
}

function FormFrame({
  title,
  onSubmit,
  error,
  busy,
  submitLabel,
  onCancel,
  children,
}: {
  title: string
  onSubmit: (event: FormEvent) => void
  error: string | null
  busy: boolean
  submitLabel: string
  onCancel: () => void
  children: ReactNode
}) {
  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border bg-surface p-5 sm:p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
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
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  )
}

// Creates a secret, or changes one when `existing` is set. With `project`, the
// new secret is added to that project in the same step. The value field
// starts empty: saved values are never shown again.
function SecretForm({
  existing,
  project,
  onSaved,
  onCancel,
}: {
  existing?: Secret
  project?: string
  onSaved: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [value, setValue] = useState('')
  const [hosts, setHosts] = useState(existing?.hosts.join(', ') ?? '')
  const [envName, setEnvName] = useState('')
  const [envEdited, setEnvEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = existing ? `secret-${existing.id}` : 'secret-new'

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (existing) {
        await api.updateSecret(existing.id, { name, ...(value ? { value } : {}), hosts: parseHosts(hosts) })
      } else {
        await api.createSecret({
          name,
          value,
          hosts: parseHosts(hosts),
          ...(project ? { assign: { project, envName } } : {}),
        })
      }
      onSaved(name.trim())
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }

  return (
    <FormFrame
      title={existing ? `Change ${existing.name}` : project ? `Add a new secret to ${project}` : 'Add a secret'}
      onSubmit={save}
      error={error}
      busy={busy}
      submitLabel={existing ? 'Save changes' : 'Add secret'}
      onCancel={onCancel}
    >
      <Field id={`${id}-name`} label="Name" hint="Something you will recognize, like the service it is for.">
        {(fieldId) => (
          <input
            id={fieldId}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!envEdited) setEnvName(defaultEnvName(e.target.value))
            }}
            placeholder="Spoolman API key"
            required
            maxLength={80}
            autoComplete="off"
            className={inputClass}
          />
        )}
      </Field>
      {project && (
        <EnvNameField
          id={`${id}-env`}
          value={envName}
          onChange={(next) => {
            setEnvEdited(true)
            setEnvName(next)
          }}
        />
      )}
      <Field
        id={`${id}-value`}
        label={existing ? 'New value' : 'Value'}
        hint={existing ? 'Leave it empty to keep the current value.' : 'Once saved, it cannot be viewed again. You can replace it.'}
      >
        {(fieldId) => (
          <input
            id={fieldId}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required={!existing}
            autoComplete="new-password"
            spellCheck={false}
            className={`${inputClass} font-mono`}
          />
        )}
      </Field>
      <Field
        id={`${id}-hosts`}
        label="Sites it may be sent to"
        hint={
          <>
            Separate them with commas. <span className="font-mono">*.example.com</span> covers every site under
            example.com. Only you can change these.
          </>
        }
      >
        {(fieldId) => (
          <input
            id={fieldId}
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder="api.example.com"
            required
            autoComplete="off"
            spellCheck={false}
            className={`${inputClass} font-mono`}
          />
        )}
      </Field>
    </FormFrame>
  )
}

// Adds an existing secret to a project. Either the secret or the project is
// fixed, and the other one is picked from `choices`.
function AssignForm({
  title,
  label,
  choices,
  fixed,
  onSaved,
  onCancel,
}: {
  title: string
  label: string
  choices: { key: string; label: string; secretName?: string }[]
  fixed: { project?: string; secret?: Secret }
  onSaved: (envName: string) => void
  onCancel: () => void
}) {
  const [choice, setChoice] = useState(choices[0]?.key ?? '')
  const secretName = fixed.secret?.name ?? choices.find((c) => c.key === choice)?.secretName ?? ''
  const [envName, setEnvName] = useState(defaultEnvName(secretName))
  const [envEdited, setEnvEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const project = fixed.project ?? choice
      const secretId = fixed.secret?.id ?? Number(choice)
      await api.assignSecret(project, envName, secretId)
      onSaved(envName)
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }

  return (
    <FormFrame title={title} onSubmit={save} error={error} busy={busy} submitLabel="Add to project" onCancel={onCancel}>
      <Field id="assign-choice" label={label}>
        {(fieldId) => (
          <select
            id={fieldId}
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value)
              const next = choices.find((c) => c.key === e.target.value)?.secretName
              if (next && !envEdited) setEnvName(defaultEnvName(next))
            }}
            className={inputClass}
          >
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <EnvNameField
        id="assign-env"
        value={envName}
        onChange={(next) => {
          setEnvEdited(true)
          setEnvName(next)
        }}
      />
    </FormFrame>
  )
}

function Hosts({ label, hosts }: { label: string; hosts: string[] }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {hosts.map((host) => (
        <li key={host} className="rounded-sm border border-border bg-surface px-2 py-0.5 font-mono text-sm break-all">
          {host}
        </li>
      ))}
    </ul>
  )
}

function useDelete<T>(action: (item: T) => Promise<void>, done: () => void) {
  const [item, setItem] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return {
    item,
    busy,
    error,
    ask: (next: T) => {
      setError(null)
      setItem(next)
    },
    cancel: () => setItem(null),
    async confirm() {
      if (item === null) return
      setBusy(true)
      setError(null)
      try {
        await action(item)
        setItem(null)
        done()
      } catch (err) {
        setError(message(err))
      } finally {
        setBusy(false)
      }
    },
  }
}

function projectList(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function SecretCard({
  secret,
  projects,
  editing,
  onEdit,
  onDelete,
  onUnassign,
  onChanged,
}: {
  secret: Secret
  projects: string[]
  editing: 'secret' | 'assign' | null
  onEdit: (mode: 'secret' | 'assign' | null) => void
  onDelete: () => void
  onUnassign: (project: string, envName: string) => void
  onChanged: (message: string) => void
}) {
  const free = projects.filter((p) => !secret.assignments.some((a) => a.project === p))
  if (editing === 'secret') {
    return (
      <li className="py-4">
        <SecretForm existing={secret} onSaved={(name) => onChanged(`Saved ${name}.`)} onCancel={() => onEdit(null)} />
      </li>
    )
  }
  return (
    <li id={`secret-${secret.id}`} className="scroll-mt-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-2">
          <h2 className="text-lg font-semibold break-words">{secret.name}</h2>
          <Hosts label={`Sites ${secret.name} may be sent to`} hosts={secret.hosts} />
          <p className="text-sm text-muted">
            <When iso={secret.updatedAt}>
              {secret.updatedAt === secret.createdAt ? 'Added' : 'Changed'} {timeAgo(secret.updatedAt)}
              {secret.updatedBy ? ` by ${secret.updatedBy}` : ''}
            </When>
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => onEdit('secret')}>Change</Button>
          <Button variant="quiet-danger" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-border">
        {secret.assignments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">No project uses it yet.</p>
        ) : (
          <ul className="divide-y divide-border" aria-label={`Projects that use ${secret.name}`}>
            {secret.assignments.map((a) => (
              <li key={a.project} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                <div className="min-w-0">
                  <p>
                    <Link to={projectPath(a.project, '/secrets')} className="font-semibold hover:underline">
                      {a.project}
                    </Link>{' '}
                    <span className="text-muted">as</span> <span className="font-mono text-sm break-all">{a.envName}</span>
                  </p>
                  <p className="text-sm text-muted">
                    <When iso={a.assignedAt}>
                      Added {timeAgo(a.assignedAt)}
                      {byText(a.assignedBy)}
                    </When>
                  </p>
                </div>
                <Button variant="quiet" onClick={() => onUnassign(a.project, a.envName)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing === 'assign' ? (
        <div className="mt-4">
          <AssignForm
            title={`Add ${secret.name} to a project`}
            label="Project"
            choices={free.map((p) => ({ key: p, label: p }))}
            fixed={{ secret }}
            onSaved={(envName) => onChanged(`Added ${secret.name} as ${envName}.`)}
            onCancel={() => onEdit(null)}
          />
        </div>
      ) : (
        free.length > 0 && (
          <Button variant="quiet" className="mt-2 -ml-4" onClick={() => onEdit('assign')}>
            Add to a project
          </Button>
        )
      )}
    </li>
  )
}

export function SecretsPage() {
  const secrets = useLoad(() => api.secrets())
  const projects = useLoad(() => api.projects())
  const [editing, setEditing] = useState<{ id: number | 'new'; mode: 'secret' | 'assign' } | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const deleting = useDelete<Secret>((secret) => api.deleteSecret(secret.id), secrets.reload)
  const unassigning = useDelete<{ project: string; envName: string }>(
    ({ project, envName }) => api.unassignSecret(project, envName),
    secrets.reload,
  )
  const projectNames = projects.data?.map((p) => p.name) ?? []

  const changed = (text: string) => {
    setEditing(null)
    setSaved(text)
    secrets.reload()
  }
  const edit = (next: typeof editing) => {
    setSaved(null)
    setEditing(next)
  }

  return (
    <div>
      <PageHeading>Secrets</PageHeading>
      <p className="mt-3 max-w-prose text-muted">
        Passwords and keys your projects use to sign in to other services. A project can only use the secrets added
        to it, and each secret is only sent to the sites listed with it.
      </p>
      <div className="mt-8 space-y-6">
        {editing?.id === 'new' ? (
          <SecretForm onSaved={(name) => changed(`Added ${name}. Add it to the projects that need it.`)} onCancel={() => setEditing(null)} />
        ) : (
          <Button variant="primary" onClick={() => edit({ id: 'new', mode: 'secret' })}>
            Add a secret
          </Button>
        )}
        {saved && <Notice tone="success">{saved}</Notice>}
        {(secrets.error || projects.error) && <Notice tone="error">{secrets.error ?? projects.error}</Notice>}
        {secrets.data?.length === 0 && <p className="text-muted">No secrets yet.</p>}
        {secrets.data && secrets.data.length > 0 && (
          <ul className="divide-y divide-border border-y border-border">
            {secrets.data.map((secret) => (
              <SecretCard
                key={secret.id}
                secret={secret}
                projects={projectNames}
                editing={editing?.id === secret.id ? editing.mode : null}
                onEdit={(mode) => edit(mode ? { id: secret.id, mode } : null)}
                onDelete={() => deleting.ask(secret)}
                onUnassign={(project, envName) => unassigning.ask({ project, envName })}
                onChanged={changed}
              />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={deleting.item !== null}
        title={`Delete ${deleting.item?.name}?`}
        confirmLabel="Delete secret"
        variant="danger"
        busy={deleting.busy}
        error={deleting.error}
        onConfirm={deleting.confirm}
        onCancel={deleting.cancel}
      >
        {deleting.item && deleting.item.assignments.length > 0 ? (
          <p>
            {projectList(deleting.item.assignments.map((a) => a.project))}{' '}
            {deleting.item.assignments.length === 1 ? 'uses' : 'use'} it. Anything that needs it stops working until you
            add a new one.
          </p>
        ) : (
          <p>No project uses it.</p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={unassigning.item !== null}
        title={`Remove from ${unassigning.item?.project}?`}
        confirmLabel="Remove"
        variant="danger"
        busy={unassigning.busy}
        error={unassigning.error}
        onConfirm={unassigning.confirm}
        onCancel={unassigning.cancel}
      >
        <p>
          Anything in {unassigning.item?.project} that uses {unassigning.item?.envName} stops working until it is added
          again. The secret stays here.
        </p>
      </ConfirmDialog>
    </div>
  )
}

function ProjectSecretRow({ secret, onRemove }: { secret: ProjectSecret; onRemove: () => void }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-4">
      <div className="min-w-0 space-y-2">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono font-semibold break-all">{secret.envName}</span>
          <Link to={`/secrets#secret-${secret.secretId}`} className="text-muted hover:text-fg hover:underline">
            {secret.secret}
          </Link>
        </p>
        <Hosts label={`Sites ${secret.envName} may be sent to`} hosts={secret.hosts} />
        <p className="text-sm text-muted">
          <When iso={secret.assignedAt}>
            Added {timeAgo(secret.assignedAt)}
            {byText(secret.assignedBy)}
          </When>
        </p>
      </div>
      <Button variant="quiet-danger" onClick={onRemove}>
        Remove
      </Button>
    </li>
  )
}

function ProjectSecrets({ project }: { project: string }) {
  const assigned = useLoad(() => api.projectSecrets(project), project)
  const library = useLoad(() => api.secrets())
  const [adding, setAdding] = useState<'existing' | 'new' | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const removing = useDelete<ProjectSecret>((secret) => api.unassignSecret(project, secret.envName), assigned.reload)
  const available = library.data?.filter((secret) => !secret.assignments.some((a) => a.project === project)) ?? []

  const done = (text: string) => {
    setAdding(null)
    setSaved(text)
    assigned.reload()
    library.reload()
  }
  const start = (mode: 'existing' | 'new') => {
    setSaved(null)
    setAdding(mode)
  }

  return (
    <div className="mt-8 space-y-6">
      {adding === 'existing' && (
        <AssignForm
          title={`Add a secret to ${project}`}
          label="Secret"
          choices={available.map((s) => ({ key: String(s.id), label: s.name, secretName: s.name }))}
          fixed={{ project }}
          onSaved={(envName) => done(`Added ${envName}.`)}
          onCancel={() => setAdding(null)}
        />
      )}
      {adding === 'new' && (
        <SecretForm project={project} onSaved={(name) => done(`Added ${name}.`)} onCancel={() => setAdding(null)} />
      )}
      {adding === null && (
        <div className="flex flex-wrap gap-3">
          {available.length > 0 && (
            <Button variant="primary" onClick={() => start('existing')}>
              Add an existing secret
            </Button>
          )}
          <Button variant={available.length > 0 ? 'secondary' : 'primary'} onClick={() => start('new')}>
            Add a new secret
          </Button>
        </div>
      )}
      {saved && <Notice tone="success">{saved}</Notice>}
      {assigned.error && <Notice tone="error">{assigned.error}</Notice>}
      {assigned.data?.length === 0 && <p className="text-muted">{project} has no secrets yet.</p>}
      {assigned.data && assigned.data.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {assigned.data.map((secret) => (
            <ProjectSecretRow key={secret.envName} secret={secret} onRemove={() => removing.ask(secret)} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removing.item !== null}
        title={`Remove ${removing.item?.envName}?`}
        confirmLabel="Remove"
        variant="danger"
        busy={removing.busy}
        error={removing.error}
        onConfirm={removing.confirm}
        onCancel={removing.cancel}
      >
        <p>
          Anything in {project} that uses it stops working until it is added again. The secret stays on the{' '}
          <Link to="/secrets" className="underline hover:text-fg">
            Secrets page
          </Link>
          .
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
            it. Agents can add secrets you created to it, but only you can create secrets and choose where they may be
            sent.
          </p>
          <ProjectSecrets project={name} />
        </>
      )}
    </ProjectLayout>
  )
}
