// Directives a hob may add sources to, with the sources the policy starts from.
// Directives that are not always in the policy fall back to default-src.
const LOOSENABLE: Record<string, { base: string[]; always: boolean }> = {
  'script-src': { base: ["'self'"], always: true },
  'style-src': { base: ["'self'", "'unsafe-inline'"], always: true },
  'img-src': { base: ["'self'", 'data:', 'blob:'], always: true },
  'font-src': { base: ["'self'", 'data:'], always: true },
  'connect-src': { base: ["'self'"], always: true },
  'form-action': { base: ["'self'"], always: true },
  'media-src': { base: ["'self'"], always: false },
  'frame-src': { base: ["'self'"], always: false },
  'worker-src': { base: ["'self'"], always: false },
  'manifest-src': { base: ["'self'"], always: false },
}

export type CspSources = Record<string, string[]>

const HOST = /^(https?|wss?):\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?(\/[^\s;,'"\\]*)?$/
const SCRIPT_KEYWORDS = new Set(["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"])
const SCHEMES = new Set(['data:', 'blob:'])
const NO_SCHEMES = new Set(['script-src', 'worker-src', 'frame-src', 'form-action', 'manifest-src'])

// hobwork.schema.json checks the same rules. This runs again so nothing that
// is not a plain source can end up in a header.
function allowed(directive: string, source: string): boolean {
  if (HOST.test(source)) return true
  if (directive === 'script-src' && SCRIPT_KEYWORDS.has(source)) return true
  return !NO_SCHEMES.has(directive) && SCHEMES.has(source)
}

// The policy for hob UIs and route responses on an app origin: no inline
// scripts, no plugins, and only the Hobwork web UI may frame it. The theme and
// its fonts are served from the app origin itself.
export function contentSecurityPolicy(hobworkOrigin: string, loosen: CspSources = {}): string {
  const directives = ["default-src 'self'"]
  for (const [name, { base, always }] of Object.entries(LOOSENABLE)) {
    const extra = (Object.hasOwn(loosen, name) ? loosen[name]! : []).filter((source) => allowed(name, source))
    if (extra.length > 0 || always) directives.push(`${name} ${[...new Set([...base, ...extra])].join(' ')}`)
  }
  // The host adds <base href="/"> to the page, so 'none' would block it.
  directives.push("object-src 'none'", "base-uri 'self'", `frame-ancestors ${hobworkOrigin}`)
  return directives.join('; ')
}
