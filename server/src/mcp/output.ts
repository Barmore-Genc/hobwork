export const MAX_OUTPUT_CHARS = 30_000

// Keeps the start and the end: commands usually print what went wrong last, and
// files and diffs start with the context needed to read the rest.
export function truncateMiddle(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - 2 * half
  return `${text.slice(0, half)}\n[... ${omitted} characters omitted ...]\n${text.slice(-half)}`
}

// Collects streamed output while keeping only the first and the last part, so a
// command that prints without end cannot grow the host's memory. The result
// stays under MAX_OUTPUT_CHARS, so truncateMiddle leaves it alone.
export class HeadTailOutput {
  #head = ''
  #tail = ''
  #omitted = 0
  readonly #keep: number

  constructor(keep: number = Math.floor(MAX_OUTPUT_CHARS / 2) - 100) {
    this.#keep = keep
  }

  push(chunk: string) {
    if (this.#head.length < this.#keep) {
      const room = this.#keep - this.#head.length
      this.#head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    this.#tail += chunk
    if (this.#tail.length > 2 * this.#keep) {
      this.#omitted += this.#tail.length - this.#keep
      this.#tail = this.#tail.slice(-this.#keep)
    }
  }

  toString(): string {
    const surplus = Math.max(this.#tail.length - this.#keep, 0)
    if (this.#omitted + surplus === 0) return this.#head + this.#tail
    return `${this.#head}\n[... ${this.#omitted + surplus} characters omitted ...]\n${this.#tail.slice(-this.#keep)}`
  }
}
