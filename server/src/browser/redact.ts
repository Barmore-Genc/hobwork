import type { BrowserSecret } from './service.ts'

// Short values are too common to redact without hiding the page's own text.
export const MIN_REDACTED_CHARS = 4
const REDACTED = '[redacted]'

// Secret values must not travel to the guest or to an agent, even by accident:
// a page that echoes a field, an error message, a URL.
export function redact(value: unknown, secrets: Record<string, BrowserSecret>): unknown {
  const values = [...new Set(Object.values(secrets).map((secret) => secret.value))]
    .filter((secret) => secret.length >= MIN_REDACTED_CHARS)
    .sort((a, b) => b.length - a.length)
  if (values.length === 0) return value
  const scrub = (text: string) => values.reduce((out, secret) => out.split(secret).join(REDACTED), text)
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return scrub(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, inner]) => [scrub(key), walk(inner)]))
    }
    return node
  }
  return walk(value)
}
