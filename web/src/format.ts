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
  return seconds > 0 ? 'in a moment' : 'just now'
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dayAndTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

export function clockTime(iso: string): string {
  return clock.format(new Date(iso))
}

// "Tue 07:30", for times within the coming week.
export function dayTime(iso: string): string {
  return dayAndTime.format(new Date(iso))
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.round(ms / 60_000)} min`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export function exactTime(iso: string): string {
  return exact.format(new Date(iso))
}

export function shortDate(iso: string): string {
  return day.format(new Date(iso))
}
