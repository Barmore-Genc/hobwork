// Same matching as Gondolin's allowlist: `*` matches any run of characters,
// case-insensitively, so `*.example.com` matches subdomains but not example.com.
export function hostMatches(hostname: string, patterns: string[]): boolean {
  const name = hostname.toLowerCase()
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) return false
    if (pattern === '*') return true
    const escaped = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${escaped}$`).test(name)
  })
}
