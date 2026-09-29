export const LOG_BURST_LINES = 100
export const LOG_LINES_PER_SECOND = 10

// Token bucket for lines a VM logs while no invocation is running, which the
// per-invocation line limit does not cover. `take` says whether to keep the
// line and how many lines were dropped since the last kept one, so the caller
// can log one summary instead of every dropped line.
export function createLogLimiter(
  options: { burst?: number; perSecond?: number; now?: () => number } = {},
) {
  const { burst = LOG_BURST_LINES, perSecond = LOG_LINES_PER_SECOND, now = Date.now } = options
  let tokens = burst
  let last = now()
  let dropped = 0
  return {
    take(): { keep: boolean; dropped: number } {
      const time = now()
      tokens = Math.min(burst, tokens + ((time - last) / 1000) * perSecond)
      last = time
      if (tokens < 1) {
        dropped++
        return { keep: false, dropped: 0 }
      }
      tokens--
      const report = dropped
      dropped = 0
      return { keep: true, dropped: report }
    },
  }
}

export type LogLimiter = ReturnType<typeof createLogLimiter>
