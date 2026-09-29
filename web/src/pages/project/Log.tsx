import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type LogLine, type LogView } from '../../api.ts'
import { Button, Notice } from '../../ui.tsx'
import { LogLines } from './LogLines.tsx'
import { ProjectLayout } from './ProjectLayout.tsx'

const VIEWS: { view: LogView; label: string }[] = [
  { view: 'all', label: 'Everything' },
  { view: 'events', label: 'Events' },
  { view: 'problems', label: 'Problems' },
]

const EMPTY: Record<LogView, string> = {
  all: 'Nothing in the log yet.',
  events: 'No events yet.',
  problems: 'No problems. All clear.',
}

const MAX_LINES = 1000
const RETRY_MS = 5000

// Mounted once per view, so switching views starts from a clean slate.
function LogFeed({ project, view, live }: { project: string; view: LogView; live: boolean }) {
  const [lines, setLines] = useState<LogLine[] | null>(null)
  const [fresh, setFresh] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Where the shown lines end. Pausing keeps the lines; resuming continues from here.
  const cursor = useRef<number | null>(null)

  useEffect(() => {
    const stop = new AbortController()
    const { signal } = stop

    async function follow() {
      if (cursor.current === null) {
        try {
          const first = await api.logs(project, { view }, signal)
          if (signal.aborted) return
          setLines(first.lines)
          setError(null)
          cursor.current = first.cursor
        } catch (err) {
          if (!signal.aborted) setError(err instanceof ApiError ? err.message : String(err))
          return
        }
      }
      while (live && !signal.aborted) {
        try {
          // The host holds the request until a line arrives or 25 seconds pass.
          const next = await api.logs(project, { view, after: cursor.current, wait: true }, signal)
          if (signal.aborted) return
          cursor.current = next.cursor
          setError(null)
          if (next.lines.length) {
            setLines((current) => [...(current ?? []), ...next.lines].slice(-MAX_LINES))
            setFresh(new Set(next.lines.map((line) => line.id)))
          }
        } catch (err) {
          if (signal.aborted) return
          setError(err instanceof ApiError ? err.message : String(err))
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
        }
      }
    }

    void follow()
    return () => stop.abort()
  }, [project, view, live])

  return (
    <div className="mt-5">
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {lines?.length === 0 && <p className="text-muted">{EMPTY[view]}</p>}
      {lines && lines.length > 0 && <LogLines project={project} lines={[...lines].reverse()} runLinks fresh={fresh} />}
    </div>
  )
}

function ProjectLog({ project }: { project: string }) {
  const [view, setView] = useState<LogView>('all')
  const [live, setLive] = useState(true)

  return (
    <section className="mt-8" aria-label="Hob log">
      <p className="max-w-prose text-muted">
        What the hob wrote while it ran, and what happened to it: updates, starts and stops, crashes and blocked
        requests. Newest first.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Show" className="inline-flex rounded-md border border-border bg-surface p-0.5">
          {VIEWS.map((item) => (
            <button
              key={item.view}
              type="button"
              aria-pressed={view === item.view}
              onClick={() => setView(item.view)}
              className={`min-h-9 rounded-[calc(var(--hw-radius-md)-2px)] px-3.5 text-[0.95rem] transition-colors ${
                view === item.view ? 'bg-surface-raised font-semibold text-fg shadow-sm' : 'text-muted hover:text-fg'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {live && (
            <span className="inline-flex items-center gap-2 text-sm text-muted" role="status">
              <span className="size-2 rounded-full bg-success animate-glow" aria-hidden="true" />
              Showing new lines as they come
            </span>
          )}
          <Button variant="quiet" onClick={() => setLive(!live)}>
            {live ? 'Pause' : 'Resume'}
          </Button>
        </div>
      </div>
      <LogFeed key={view} project={project} view={view} live={live} />
    </section>
  )
}

export function LogPage({ name }: { name: string }) {
  return (
    <ProjectLayout name={name} tab="log">
      {() => <ProjectLog project={name} />}
    </ProjectLayout>
  )
}
