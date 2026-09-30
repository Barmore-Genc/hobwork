import { useState, type FormEvent } from 'react'
import { api, ApiError, type AiSettings } from '../../api.ts'
import { exactTime, timeAgo } from '../../format.ts'
import { Link } from '../../router.tsx'
import { Button, Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { draftLimits, draftModels, limitsDraft, modelsDraft } from '../ai-drafts.ts'
import { LimitsFields, ModelFields, UsageTable } from '../ai.tsx'
import { projectPath } from '../project/names.ts'

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
