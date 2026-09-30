import { useState, type FormEvent } from 'react'
import { api, ApiError, type ProjectAi } from '../../api.ts'
import { exactTime, timeAgo } from '../../format.ts'
import { Link } from '../../router.tsx'
import { Button, Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { count, describeLimits, draftLimits, draftModels, limitsDraft, modelsDraft, money } from '../ai-drafts.ts'
import { LimitsFields, ModelFields, UsageTable } from '../ai.tsx'
import { ProjectLayout } from './ProjectLayout.tsx'

function Usage({ usage }: { usage: ProjectAi['usage'] }) {
  const tiles = [
    { label: 'Last 24 hours', cost: usage.day.cost, requests: usage.day.requests },
    { label: 'Last 30 days', cost: usage.month.cost, requests: usage.month.requests },
  ]
  return (
    <section aria-labelledby="ai-use" className="mt-8">
      <h2 id="ai-use" className="text-xl font-semibold">
        Use
      </h2>
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-border bg-surface p-4">
            <dt className="text-sm text-muted">{tile.label}</dt>
            <dd className="mt-1 font-display text-2xl font-semibold tabular">{money(tile.cost)}</dd>
            <dd className="text-sm text-muted tabular">
              {count(tile.requests)} request{tile.requests === 1 ? '' : 's'}
            </dd>
          </div>
        ))}
        <div className="rounded-lg border border-border bg-surface p-4">
          <dt className="text-sm text-muted">Right now</dt>
          <dd className="mt-1 font-display text-2xl font-semibold tabular">{count(usage.lastMinute)}</dd>
          <dd className="text-sm text-muted tabular">
            in the last minute, {count(usage.lastHour)} in the last hour
          </dd>
        </div>
      </dl>
      {usage.month.refused > 0 && (
        <p className="mt-4 text-muted">
          Hobwork refused {count(usage.month.refused)} request{usage.month.refused === 1 ? '' : 's'} in the last 30 days
          because of the settings below. The log shows why.
        </p>
      )}
      {usage.models.length > 0 && (
        <UsageTable
          rows={usage.models.map((row) => ({
            key: row.model ?? '',
            label: row.model ? <span className="font-mono text-sm">{row.model}</span> : <span className="text-muted">No model named</span>,
            requests: row.requests,
            refused: row.refused,
            tokens: row.promptTokens + row.completionTokens,
            cost: row.cost,
          }))}
        />
      )}
    </section>
  )
}

function SettingsForm({ name, current, onSaved }: { name: string; current: ProjectAi; onSaved: () => void }) {
  const [models, setModels] = useState(() => modelsDraft(current.project))
  const [own, setOwn] = useState(current.project.limits !== null)
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
      const next = await api.saveProjectAi(name, { ...draftModels(models), limits: own ? draftLimits(limits) : null })
      setModels(modelsDraft(next.project))
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
    <section aria-labelledby="ai-settings" className="mt-12">
      <h2 id="ai-settings" className="text-xl font-semibold">
        What {name} uses
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Applies to the running hob, its previews and agents trying it out.{' '}
        <Link to="/settings" className="underline hover:text-fg">
          Settings
        </Link>{' '}
        has the models and limits for every hob.
      </p>
      <form onSubmit={save} className="mt-6 space-y-6 rounded-lg border border-border bg-surface p-5 sm:p-6">
        <ModelFields id="project-ai" draft={models} onChange={setModels} inherited={current.host.models} inheritFrom="The model from Settings" />
        <fieldset>
          <legend className="font-semibold">Limits</legend>
          <div className="mt-2 space-y-2">
            <label className="flex items-start gap-3">
              <input type="radio" name="project-ai-limits" checked={!own} onChange={() => setOwn(false)} className="mt-1.5 accent-accent" />
              <span>
                The limits from Settings
                <span className="block text-sm text-muted">{describeLimits(current.host.limits)}</span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input type="radio" name="project-ai-limits" checked={own} onChange={() => setOwn(true)} className="mt-1.5 accent-accent" />
              <span>Limits for this hob</span>
            </label>
          </div>
          {own && (
            <div className="mt-4">
              <LimitsFields id="project-ai" draft={limits} onChange={setLimits} />
            </div>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {current.project.updatedAt && (
            <p className="text-sm text-muted sm:ml-auto">
              Changed <span title={exactTime(current.project.updatedAt)}>{timeAgo(current.project.updatedAt)}</span>
              {current.project.updatedBy && ` by ${current.project.updatedBy}`}
            </p>
          )}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {saved && !error && <Notice tone="success">Saved. The hob uses the new settings on its next request.</Notice>}
      </form>
    </section>
  )
}

function ProjectAiContent({ name }: { name: string }) {
  const { data, error, reload } = useLoad(() => api.projectAi(name), name)
  return (
    <>
      {error && (
        <div className="mt-8">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {data && (
        <>
          <p className="mt-8 max-w-prose text-muted">
            {name} calls AI models through OpenRouter. Hobwork picks the model for every call, counts it and stops calls
            past the limits.
          </p>
          <Usage usage={data.usage} />
          <SettingsForm name={name} current={data} onSaved={reload} />
        </>
      )}
    </>
  )
}

export function ProjectAiPage({ name }: { name: string }) {
  return (
    <ProjectLayout name={name} tab="ai">
      {() => <ProjectAiContent name={name} />}
    </ProjectLayout>
  )
}
