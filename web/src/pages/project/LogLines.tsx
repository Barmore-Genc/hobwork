import type { LogLine } from '../../api.ts'
import { clockTime, exactTime } from '../../format.ts'
import { Link } from '../../router.tsx'
import { projectPath } from './names.ts'

const EVENT_LABELS: Record<string, string> = {
  start: 'Started',
  stop: 'Stopped',
  crash: 'Crashed',
  deploy: 'Update',
  'auto-revert': 'Rolled back',
  'egress-blocked': 'Blocked',
  trigger: 'Home Assistant',
  pipeline: 'Check',
  migration: 'Data change',
  db: 'Data',
  secret: 'Secret',
}

const LEVEL_STYLES: Record<LogLine['level'], string> = {
  debug: 'text-muted',
  info: '',
  warn: 'text-warning',
  error: 'text-danger',
}

const LEVEL_BARS: Record<LogLine['level'], string> = {
  debug: 'border-transparent',
  info: 'border-transparent',
  warn: 'border-warning',
  error: 'border-danger',
}

export function LogLines({
  project,
  lines,
  runLinks,
  fresh,
}: {
  project: string
  lines: LogLine[]
  runLinks: boolean
  // Lines that just arrived, highlighted briefly.
  fresh?: Set<number>
}) {
  return (
    <ol className="divide-y divide-border/70 border-y border-border">
      {lines.map((line) => (
        <li
          key={line.id}
          className={`grid grid-cols-[4.75rem_1fr] gap-x-3 border-l-2 py-2 pr-1 pl-2.5 sm:grid-cols-[5.5rem_1fr] ${LEVEL_BARS[line.level]} ${
            fresh?.has(line.id) ? 'animate-arrive' : ''
          }`}
        >
          <time dateTime={line.time} title={exactTime(line.time)} className="pt-px text-[0.8rem] text-muted tabular">
            {clockTime(line.time)}
          </time>
          <div className="min-w-0">
            {(line.event || (runLinks && line.invocationId !== null)) && (
              <p className="mb-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8rem]">
                {line.event && (
                  <span className="rounded-sm bg-surface px-1.5 font-semibold text-fg ring-1 ring-border">
                    {EVENT_LABELS[line.event] ?? line.event}
                  </span>
                )}
                {runLinks && line.invocationId !== null && (
                  <Link
                    to={projectPath(project, `/activity/${line.invocationId}`)}
                    className="text-muted underline decoration-border underline-offset-4 hover:text-fg"
                  >
                    Run {line.invocationId}
                  </Link>
                )}
              </p>
            )}
            <p
              className={`font-mono text-[0.83rem] leading-relaxed break-words whitespace-pre-wrap ${LEVEL_STYLES[line.level]}`}
            >
              {line.message}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}
