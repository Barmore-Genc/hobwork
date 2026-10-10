// Wall-clock time in IANA time zones, for handlers and for the host's cron
// scheduler. Runs on Intl alone, so it works in runtime VMs and browsers.
import type { Weekday } from './devices.ts'

export type LocalTime = {
  timeZone: string
  year: number
  // 1-12.
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: Weekday
  // "2026-10-09", "08:30": the formats alarms and screen time take.
  date: string
  time: string
  // Minutes ahead of UTC, e.g. 180 for Europe/Istanbul.
  offsetMinutes: number
}

const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_MS = 24 * 60 * 60 * 1000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, format)
  }
  return format
}

// True for zones this runtime knows, such as "Europe/Istanbul" and "UTC".
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 64) return false
  try {
    formatter(value)
    return true
  } catch {
    return false
  }
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number }

function wallOf(ms: number, timeZone: string): Wall {
  const parts: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! }
}

function wallMs(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
}

// Milliseconds the zone is ahead of UTC at this instant.
function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000
  return wallMs(wallOf(whole, timeZone)) - whole
}

const pad = (n: number) => String(n).padStart(2, '0')

type Zone = string | { timeZone: string }

const zoneOf = (zone: Zone) => (typeof zone === 'string' ? zone : zone.timeZone)

// The wall-clock time at `at` (default: now) in a time zone or a person's,
// e.g. localTime(ctx.caller.person).
export function localTime(zone: Zone, at: Date = new Date()): LocalTime {
  const timeZone = zoneOf(zone)
  const ms = at.getTime()
  const wall = wallOf(ms, timeZone)
  return {
    timeZone,
    ...wall,
    weekday: WEEKDAYS[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()]!,
    date: `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`,
    time: `${pad(wall.hour)}:${pad(wall.minute)}`,
    offsetMinutes: Math.round(offsetAt(ms, timeZone) / 60_000),
  }
}

// The instant a wall-clock time happens in timeZone. A time skipped by a DST
// change does not exist (undefined); a time that happens twice gives the first.
export function zonedInstant(
  timeZone: string,
  wall: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
): Date | undefined {
  const target: Wall = { hour: 0, minute: 0, second: 0, ...wall }
  const guess = wallMs(target)
  // Offsets a day either side cover any single DST change around the time.
  const candidates = [...new Set([offsetAt(guess - DAY_MS, timeZone), offsetAt(guess + DAY_MS, timeZone)])]
    .map((offset) => guess - offset)
    .filter((ms) => wallMs(wallOf(ms, timeZone)) === guess)
    .sort((a, b) => a - b)
  return candidates.length ? new Date(candidates[0]!) : undefined
}

// The instant of "2026-10-09" at "08:30" in a time zone or a person's, or
// undefined when DST skips that time. Throws on malformed input.
export function fromLocalTime(zone: Zone, date: string, time = '00:00'): Date | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time)
  if (!d || !t) throw new RangeError(`Expected a date like "2026-10-09" and a time like "08:30", got "${date}" "${time}"`)
  return zonedInstant(zoneOf(zone), {
    year: Number(d[1]),
    month: Number(d[2]),
    day: Number(d[3]),
    hour: Number(t[1]),
    minute: Number(t[2]),
    second: Number(t[3] ?? 0),
  })
}
