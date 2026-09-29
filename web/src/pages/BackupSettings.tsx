import { useEffect, useState } from 'react'
import { api, ApiError, type BackupRun } from '../api.ts'
import { bytes, dayTime, duration, exactTime, timeAgo } from '../format.ts'
import { Button, Notice } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'
import { kindChanged } from '../live.ts'

const POLL_MS = 3000

function runSummary(run: BackupRun): string {
  if (run.status === 'running') return 'Backing up…'
  if (run.status === 'failed') return 'Failed'
  const parts = [run.totalBytes === null ? null : bytes(run.totalBytes)]
  if (run.uploadedBytes !== null) parts.push(`${bytes(run.uploadedBytes)} new`)
  if (run.durationMs !== null) parts.push(duration(run.durationMs))
  return parts.filter(Boolean).join(', ')
}

export function BackupSettings() {
  const { data: status, error, reload } = useLoad(api.backups, '', kindChanged('backups'))
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const running = status?.configured === true && status.running

  useEffect(() => {
    if (!running) return
    const timer = setInterval(reload, POLL_MS)
    return () => clearInterval(timer)
  }, [running, reload])

  async function start() {
    setStarting(true)
    setStartError(null)
    try {
      await api.startBackup()
      reload()
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const last = status?.configured ? status.runs.find((run) => run.status !== 'running') : undefined

  return (
    <section aria-labelledby="backups" className="mt-14">
      <h2 id="backups" className="text-2xl font-semibold">
        Backups
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Hobwork copies every hob, its data and its secrets to off-site storage. Each backup only sends what
        changed since the one before.
      </p>

      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {status && !status.configured && (
        <p className="mt-6 max-w-prose rounded-lg border border-border bg-surface p-5 sm:p-6">
          Backups are off, so nothing is copied off this server. Whoever runs the server can turn them on by setting
          the <code className="font-mono text-sm">HOBWORK_BACKUP_*</code> settings.
        </p>
      )}

      {status?.configured && (
        <div className="mt-6 rounded-lg border border-border bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-2.5 size-2.5 shrink-0 rounded-full ${
                  running ? 'animate-glow bg-accent' : last?.status === 'failed' ? 'bg-danger' : status.lastSuccess ? 'bg-success' : 'bg-muted/50'
                }`}
              />
              <div>
                <p className="font-display text-lg font-semibold">
                  {running
                    ? 'Backing up now…'
                    : last?.status === 'failed'
                      ? 'The last backup failed'
                      : status.lastSuccess
                        ? <>Backed up <span title={exactTime(status.lastSuccess.startedAt)}>{timeAgo(status.lastSuccess.startedAt)}</span></>
                        : 'Not backed up yet'}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {status.nextRun ? `Next backup ${dayTime(status.nextRun)}. ` : 'Backups only run when you start one. '}
                  Keeps {status.retention.daily} daily, {status.retention.weekly} weekly and {status.retention.monthly}{' '}
                  monthly backups in <span className="break-all">{status.destination}</span>.
                </p>
              </div>
            </div>
            <Button variant="primary" onClick={start} disabled={starting || running}>
              {running ? 'Backing up…' : 'Back up now'}
            </Button>
          </div>

          {last?.status === 'failed' && last.error && (
            <div className="mt-4">
              <Notice tone="error">
                <span className="break-words">{last.error}</span>
              </Notice>
            </div>
          )}
          {startError && (
            <div className="mt-4">
              <Notice tone="error">{startError}</Notice>
            </div>
          )}
        </div>
      )}

      {status?.configured && status.runs.length > 0 && (
        <ul className="mt-6 divide-y divide-border border-y border-border" aria-label="Recent backups">
          {status.runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
              <span>
                {exactTime(run.startedAt)}
                <span className="text-muted">{run.trigger === 'manual' ? ' (started by hand)' : ''}</span>
              </span>
              <span className={`text-sm ${run.status === 'failed' ? 'text-danger' : 'text-muted'}`}>{runSummary(run)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
