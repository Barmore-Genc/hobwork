export const MAX_LINE_CHARS = 8192

// Splits streamed text into lines. A line longer than `max` is cut there and
// the rest of it is discarded, so a guest that never writes a newline cannot
// grow the host's memory.
export function createLineSplitter(emit: (line: string) => void, max: number = MAX_LINE_CHARS) {
  let partial = ''
  let discarding = false
  const push = (text: string) => {
    let start = 0
    while (start <= text.length) {
      const newline = text.indexOf('\n', start)
      const end = newline === -1 ? text.length : newline
      if (!discarding) {
        partial += text.slice(start, Math.min(end, start + max + 1))
        if (partial.length > max) {
          emit(`${partial.slice(0, max)} [line cut]`)
          partial = ''
          discarding = true
        }
      }
      if (newline === -1) return
      if (!discarding) emit(partial)
      partial = ''
      discarding = false
      start = newline + 1
    }
  }
  // Emits the last line when the stream ends without a newline.
  const flush = () => {
    if (!discarding && partial) emit(partial)
    partial = ''
    discarding = false
  }
  return Object.assign(push, { flush })
}
