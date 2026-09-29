const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

export function exactTime(iso: string): string {
  return exact.format(new Date(iso))
}

export function shortDate(iso: string): string {
  return day.format(new Date(iso))
}
