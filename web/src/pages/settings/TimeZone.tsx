import { useState } from 'react'
import { api, ApiError } from '../../api.ts'
import { kindChanged } from '../../live.ts'
import { Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { inputClass } from '../ai-drafts.ts'

const AUTOMATIC = ''

function zones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

export function TimeZoneSection() {
  const { data, error, reload } = useLoad(api.timeZone, '', kindChanged('people'))
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [all] = useState(zones)

  async function choose(value: string) {
    setBusy(true)
    setSaveError(null)
    try {
      await api.setTimeZone(value === AUTOMATIC ? null : value)
      reload()
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const current = data?.timeZone ?? data?.host
  const options = data?.manual && data.timeZone && !all.includes(data.timeZone) ? [data.timeZone, ...all] : all

  return (
    <section aria-labelledby="time-zone" className="mt-14">
      <h2 id="time-zone" className="text-2xl font-semibold">
        Time zone
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Hobs use it for your local time, for example to remind you in the morning. Automatic follows the browser and
        Hobwork app you use.
      </p>
      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {data && (
        <div className="mt-6 max-w-md">
          <label htmlFor="time-zone-choice" className="font-semibold">
            Your time zone
          </label>
          <select
            id="time-zone-choice"
            value={data.manual && data.timeZone ? data.timeZone : AUTOMATIC}
            onChange={(e) => void choose(e.target.value)}
            disabled={busy}
            className={inputClass}
          >
            <option value={AUTOMATIC}>Automatic ({current})</option>
            {options.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
          {saveError && (
            <div className="mt-4">
              <Notice tone="error">{saveError}</Notice>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
