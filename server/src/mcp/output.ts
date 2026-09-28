export const MAX_OUTPUT_CHARS = 30_000

// Keeps the start and the end: commands usually print what went wrong last, and
// files and diffs start with the context needed to read the rest.
export function truncateMiddle(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - 2 * half
  return `${text.slice(0, half)}\n[... ${omitted} characters omitted ...]\n${text.slice(-half)}`
}
