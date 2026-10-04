import { useState, type FormEvent } from 'react'
import { api, ApiError, type AiSettings } from '../../api.ts'
import { exactTime, timeAgo } from '../../format.ts'
import { Link } from '../../router.tsx'
import { Button, ConfirmDialog, Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { draftLimits, draftModels, inputClass, limitsDraft, modelsDraft } from '../ai-drafts.ts'
import { LimitsFields, ModelFields, UsageTable } from '../ai.tsx'
import { projectPath } from '../project/names.ts'

function KeyForm({ apiKey, onSaved }: { apiKey: NonNullable<AiSettings['apiKey']>; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const { secret, ownKey } = apiKey

  async function run(kind: 'save' | 'remove', action: () => Promise<unknown>, done: string) {
    setBusy(kind)
    setError(null)
    setSaved(null)
    try {
      await action()
      setValue('')
      setConfirmRemove(false)
      setSaved(done)
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  function save(event: FormEvent) {
    event.preventDefault()
    void run('save', () => api.saveAiKey(value), 'Saved. Hobs use the key on their next request.')
  }

  return (
    <form onSubmit={save} className="mt-6 space-y-4 rounded-lg border border-border bg-surface p-5 sm:p-6">
      <div>
        <label htmlFor="ai-key" className="font-semibold">
          OpenRouter API key
        </label>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Every hob uses this key for AI. Create one in your{' '}
          <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" className="underline hover:text-fg">
            OpenRouter settings
          </a>
          .
        </p>
        <input
          id="ai-key"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={secret ? 'Saved. Paste a new key to replace it' : 'Paste the key'}
          autoComplete="off"
          spellCheck={false}
          className={`${inputClass} font-mono text-sm placeholder:font-sans`}
        />
        {secret && (
          <p className="mt-2 text-sm text-muted">
            Saved as the secret{' '}
            <Link to={`/secrets#secret-${secret.id}`} className="underline hover:text-fg">
              {secret.name}
            </Link>
            , changed <span title={exactTime(secret.updatedAt)}>{timeAgo(secret.updatedAt)}</span>
            {secret.updatedBy && ` by ${secret.updatedBy}`}.
          </p>
        )}
        {ownKey.length > 0 && (
          <p className="mt-2 text-sm text-muted">
            {ownKey.length === 1 ? 'This hob uses its own key' : 'These hobs use their own keys'}:{' '}
            {ownKey.map((project, i) => (
              <span key={project}>
                {i > 0 && ', '}
                <Link to={projectPath(project, '/secrets')} className="font-semibold hover:text-accent-fg">
                  {project}
                </Link>
              </span>
            ))}
            .
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy !== null || !value.trim()}>
          {busy === 'save' ? 'Saving…' : secret ? 'Replace key' : 'Save key'}
        </Button>
        {secret && (
          <Button variant="quiet-danger" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
            Remove key
          </Button>
        )}
      </div>
      {error && !confirmRemove && <Notice tone="error">{error}</Notice>}
      {saved && !error && <Notice tone="success">{saved}</Notice>}
      <ConfirmDialog
        open={confirmRemove}
        title="Remove the OpenRouter API key?"
        confirmLabel="Remove"
        variant="danger"
        busy={busy === 'remove'}
        error={confirmRemove ? error : null}
        onConfirm={() => void run('remove', api.removeAiKey, 'Removed the key.')}
        onCancel={() => {
          setConfirmRemove(false)
          setError(null)
        }}
      >
        <p>AI stops working in every hob that does not have its own key.</p>
      </ConfirmDialog>
    </form>
  )
}

function AiForm({ current, onSaved }: { current: AiSettings; onSaved: () => void }) {
  const [models, setModels] = useState(() => modelsDraft(current))
  const [limits, setLimits] = useState(() => limitsDraft(current.limits))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api.saveAiSettings({ ...draftModels(models), limits: draftLimits(limits) })
      setModels(modelsDraft(next))
      setLimits(limitsDraft(next.limits))
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="mt-6 space-y-6 rounded-lg border border-border bg-surface p-5 sm:p-6">
      <ModelFields id="ai" draft={models} onChange={setModels} inherited={current.defaults.models} inheritFrom="The default" />
      <LimitsFields id="ai" draft={limits} onChange={setLimits} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button onClick={() => setLimits(limitsDraft(current.defaults.limits))} disabled={busy}>
          Use the suggested limits
        </Button>
        {current.updatedAt && (
          <p className="text-sm text-muted sm:ml-auto">
            Changed <span title={exactTime(current.updatedAt)}>{timeAgo(current.updatedAt)}</span>
            {current.updatedBy && ` by ${current.updatedBy}`}
          </p>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {saved && !error && <Notice tone="success">Saved. Hobs use the new settings on their next request.</Notice>}
    </form>
  )
}

export function AiSection() {
  const { data: current, error, reload } = useLoad(api.aiSettings)

  return (
    <section aria-labelledby="ai" className="mt-14">
      <h2 id="ai" className="text-2xl font-semibold">
        AI
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Hobs use AI models through OpenRouter. Choose the models they use and how much they may spend. A hob can
        get its own models and limits on its AI page.
      </p>

      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {current && (
        <>
          {current.apiKey && <KeyForm apiKey={current.apiKey} onSaved={reload} />}
          <AiForm current={current} onSaved={reload} />
          <h3 className="mt-8 text-lg font-semibold">Use in the last 30 days</h3>
          {current.usage.length === 0 ? (
            <p className="mt-2 text-muted">No hob has used AI in the last 30 days.</p>
          ) : (
            <UsageTable
              rows={current.usage.map((row) => ({
                key: row.project,
                label: (
                  <Link to={projectPath(row.project, '/ai')} className="font-semibold hover:text-accent-fg">
                    {row.project}
                  </Link>
                ),
                requests: row.requests,
                refused: row.refused,
                cost: row.cost,
              }))}
            />
          )}
        </>
      )}
    </section>
  )
}
