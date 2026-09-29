import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../../api.ts'
import { Button, Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { inputClass } from '../ai-drafts.ts'
import { ProjectLayout } from './ProjectLayout.tsx'

function toDraft(services: string[]): string {
  return services.join('\n')
}

function fromDraft(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function ServicesForm({ name, services, onSaved }: { name: string; services: string[]; onSaved: () => void }) {
  const [draft, setDraft] = useState(() => toDraft(services))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api.saveHaServices(name, fromDraft(draft))
      setDraft(toDraft(next.services))
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="ha-services" className="mt-8">
      <h2 id="ha-services" className="text-xl font-semibold">
        Services and events {name} may use
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        {name} can switch things in your home only through the Home Assistant services listed here, and can send only
        the events listed here, which can start your automations. Anything else is refused and shows up in the log.
        Agents can add entries too, and the log says when they do.
      </p>
      <form onSubmit={save} className="mt-6 space-y-4 rounded-lg border border-border bg-surface p-5 sm:p-6">
        <div>
          <label htmlFor="ha-services-list" className="font-semibold">
            Allowed services and events
          </label>
          <textarea
            id="ha-services-list"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            placeholder={'light\ntts.speak\nevent:spool_empty'}
            spellCheck={false}
            className={`${inputClass} mt-2 py-2 font-mono text-sm`}
          />
          <p className="mt-1 text-sm text-muted">
            One per line. A domain like light allows all its services, and light.turn_on allows only that one. An
            entry like event:spool_empty lets the hob send that event. An empty list allows none.
          </p>
          <p className="mt-1 text-sm text-muted">
            hassio, homeassistant, shell_command and recorder.purge can change or stop Home Assistant itself, so no hob
            may call them. Events Home Assistant uses itself, such as state_changed and homeassistant_start, cannot be
            sent either.
          </p>
        </div>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {error && <Notice tone="error">{error}</Notice>}
        {saved && !error && <Notice tone="success">Saved. The hob uses the new list on its next call.</Notice>}
      </form>
    </section>
  )
}

function Content({ name }: { name: string }) {
  const { data, error, reload } = useLoad(() => api.haServices(name), name)
  return (
    <>
      {error && (
        <div className="mt-8">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {data && <ServicesForm key={data.services.join(',')} name={name} services={data.services} onSaved={reload} />}
    </>
  )
}

export function ProjectHomeAssistantPage({ name }: { name: string }) {
  return (
    <ProjectLayout name={name} tab="home-assistant">
      {() => <Content name={name} />}
    </ProjectLayout>
  )
}
