import type { LogLevel } from '../index.ts'
import type { LogBatch, LogLine } from './protocol.ts'

// Calls from the runtime VM to the host. The host knows which project and
// version a VM runs, so requests carry no credentials.
export type HostClient = {
  log(invocation: number | undefined, level: LogLevel, message: string): void
  // Resolves once every line logged so far reached the host.
  flush(): Promise<void>
}

const FLUSH_DELAY_MS = 100
const MAX_BATCH = 200

export function createHostClient(baseUrl: string): HostClient {
  let pending: LogLine[] = []
  let timer: NodeJS.Timeout | undefined
  let sending: Promise<void> = Promise.resolve()

  async function post(lines: LogLine[]): Promise<void> {
    try {
      const res = await fetch(new URL('/v1/logs', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines } satisfies LogBatch),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      process.stderr.write(`Could not send ${lines.length} log lines to the host: ${(err as Error).message}\n`)
    }
  }

  function flush(): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    if (pending.length) {
      const lines = pending
      pending = []
      // Batches go out one after another so lines arrive in order.
      sending = sending.then(() => post(lines))
    }
    return sending
  }

  return {
    log(invocation, level, message) {
      pending.push({ invocation, level, message, time: new Date().toISOString() })
      if (pending.length >= MAX_BATCH) void flush()
      else timer ??= setTimeout(() => void flush(), FLUSH_DELAY_MS)
    },
    flush,
  }
}
