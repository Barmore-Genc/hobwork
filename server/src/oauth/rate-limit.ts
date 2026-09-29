import { isIPv6 } from 'node:net'

// One person usually holds a whole IPv6 /64, so limits keyed by the full
// address would give them 2^64 windows.
export function rateLimitKey(address: string): string {
  if (!isIPv6(address)) return address
  const [head = '', tail] = address.split('::') as [string, string | undefined]
  const groups = head === '' ? [] : head.split(':')
  if (tail === undefined && groups.length < 4) return address
  while (groups.length < 4) groups.push('0')
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

// Fixed-window counter per key (the client's address, or its /64 for IPv6). In memory: a restart
// resets it, which only gives a script one more window.
export function createRateLimiter(options: { limit: number; windowMs: number; now: () => number }) {
  const { limit, windowMs, now } = options
  const windows = new Map<string, { start: number; count: number }>()

  return {
    // Counts the attempt. Returns the seconds to wait when it is over the limit.
    take(key: string): number | undefined {
      const time = now()
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (time - w.start >= windowMs) windows.delete(k)
      }
      const current = windows.get(key)
      if (!current || time - current.start >= windowMs) {
        windows.set(key, { start: time, count: 1 })
        return undefined
      }
      current.count++
      if (current.count <= limit) return undefined
      return Math.max(1, Math.ceil((current.start + windowMs - time) / 1000))
    },
  }
}
