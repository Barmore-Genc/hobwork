import type { Host } from '../host.ts'
import { createLineSplitter } from '../runtime/line-splitter.ts'
import { createLogLimiter } from '../runtime/log-limiter.ts'
import { appendLogs, type NewLogEntry } from '../runtime/logs.ts'

// A run's lines beyond this are dropped, so a step that prints without end
// cannot fill the log store. The step's stored output keeps its head and tail.
export const MAX_PIPELINE_LOG_LINES = 5_000
const BURST_LINES = 2_000
const LINES_PER_SECOND = 1_000

export type PipelineLog = ReturnType<typeof createPipelineLog>

export function createPipelineLog(
  host: Host,
  run: { project: string; branch?: string; id: number },
  options: { maxLines?: number; now?: () => number } = {},
) {
  const maxLines = options.maxLines ?? MAX_PIPELINE_LOG_LINES
  const limiter = createLogLimiter({ burst: BURST_LINES, perSecond: LINES_PER_SECOND, now: options.now })
  let stored = 0
  let capped = false
  let entries: NewLogEntry[] = []

  function entry(step: string, message: string): NewLogEntry {
    return { project: run.project, branch: run.branch, source: 'pipeline', level: 'info', message: `run ${run.id} ${step}: ${message}` }
  }

  function add(step: string, message: string) {
    if (capped) return
    const { keep, dropped } = limiter.take()
    if (dropped) entries.push(entry(step, `[${dropped} lines skipped]`))
    if (!keep) return
    if (stored >= maxLines) {
      capped = true
      entries.push(entry(step, "[output limit reached, the rest of this run's output is in the run's step output]"))
      return
    }
    stored++
    entries.push(entry(step, message))
  }

  function write() {
    const batch = entries
    entries = []
    try {
      appendLogs(host, batch)
    } catch (err) {
      console.error(`Could not record pipeline output for ${run.project}`, err)
    }
  }

  return {
    step(name: string) {
      const splitters = [0, 1].map(() =>
        createLineSplitter((line) => {
          if (line.trim()) add(name, line)
        }),
      )
      return {
        output(stream: 'stdout' | 'stderr', text: string) {
          splitters[stream === 'stderr' ? 1 : 0]!(text)
          write()
        },
        // For output that did not stream, like the validate step's.
        text(text: string) {
          for (const line of text.split('\n')) if (line.trim()) add(name, line)
          write()
        },
        end() {
          for (const splitter of splitters) splitter.flush()
          write()
        },
      }
    },
  }
}
