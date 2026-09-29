import { DeviceError } from './registry.ts'

// Capabilities whose calls are commands (see "Device protocol" in
// docs/architecture.md). The app checks arguments too, but a handler gets a
// clear bad_request here without waking the phone.

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export const HEALTH_TYPES = ['sleep', 'steps', 'heartRate', 'restingHeartRate', 'activeEnergy', 'bodyMass', 'workouts', 'mindfulness'] as const
export const MAX_HEALTH_SAMPLES = 1000
export const MAX_NFC_TEXT_BYTES = 1024
const MAX_TITLE = 100
const MAX_TIMER_SECONDS = 24 * 60 * 60
const MAX_LIMIT_MINUTES = 24 * 60 - 1
// ISO 8601 with a time zone, so "07:00" means the same on the host and the phone.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

type Args = Record<string, unknown>

export type CommandSpec = {
  // Needs the app in the foreground (the NFC scan sheet), so it is sent as a
  // push the person taps rather than one the notification service extension runs.
  foreground?: boolean
  // Checks the handler's arguments and returns what goes to the device.
  parse(args: Args, now: number): Args
}

function bad(message: string): never {
  throw new DeviceError('bad_request', message)
}

function only(args: Args, method: string, allowed: string[]) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      bad(allowed.length ? `${method} does not take "${key}". It takes ${allowed.join(', ')}` : `${method} takes no arguments`)
    }
  }
}

function title(args: Args): string {
  const value = args.title
  if (typeof value !== 'string' || !value.trim()) bad('title must be a non-empty string')
  if (value.length > MAX_TITLE) bad(`title must be at most ${MAX_TITLE} characters`)
  return value
}

function slug(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !SLUG.test(value)) {
    bad(`${key} must be a name of lowercase letters, digits and hyphens (at most 40), like "social"`)
  }
  return value
}

function dateTime(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    bad(`${key} must be an ISO date-time with a time zone, like "2026-10-01T07:00:00+02:00" or new Date().toISOString()`)
  }
  return value
}

function futureDateTime(args: Args, key: string, now: number): string {
  const value = dateTime(args, key)
  if (Date.parse(value) <= now) bad(`${key} is in the past`)
  return value
}

function time(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !TIME.test(value)) bad(`${key} must be a local time like "07:30" (24-hour, HH:MM)`)
  return value
}

function days(args: Args): (typeof DAYS)[number][] | undefined {
  const value = args.days
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((d) => !(DAYS as readonly unknown[]).includes(d)) ||
    new Set(value).size !== value.length
  ) {
    bad(`days must be a non-empty list of different days from ${DAYS.map((d) => `"${d}"`).join(', ')}`)
  }
  return value as (typeof DAYS)[number][]
}

function integer(args: Args, key: string, min: number, max: number): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    bad(`${key} must be a whole number from ${min} to ${max}`)
  }
  return value
}

function optionalId(args: Args): { id?: string } {
  if (args.id === undefined) return {}
  if (typeof args.id !== 'string' || !UUID.test(args.id)) bad('id must be a UUID, like one an earlier call returned')
  return { id: args.id }
}

function defined(args: Args): Args {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
}

const noArgs = (method: string): CommandSpec => ({
  parse(args) {
    only(args, method, [])
    return {}
  },
})

export const COMMANDS: Record<string, Record<string, CommandSpec>> = {
  alarms: {
    set: {
      parse(args, now) {
        only(args, 'alarms.set', ['title', 'at', 'time', 'days', 'id'])
        if ((args.at === undefined) === (args.time === undefined)) {
          bad('alarms.set needs exactly one of at (a date-time, for one alarm) or time ("HH:MM", repeating on days)')
        }
        if (args.at !== undefined && args.days !== undefined) bad('days only works with time, not with at')
        return defined({
          title: title(args),
          at: args.at === undefined ? undefined : futureDateTime(args, 'at', now),
          time: args.time === undefined ? undefined : time(args, 'time'),
          days: days(args),
          ...optionalId(args),
        })
      },
    },
    timer: {
      parse(args) {
        only(args, 'alarms.timer', ['title', 'seconds', 'id'])
        return { title: title(args), seconds: integer(args, 'seconds', 1, MAX_TIMER_SECONDS), ...optionalId(args) }
      },
    },
    cancel: {
      parse(args) {
        only(args, 'alarms.cancel', ['id'])
        if (args.id === undefined) bad('alarms.cancel needs the id that alarms.set or alarms.timer returned')
        return optionalId(args)
      },
    },
    list: noArgs('alarms.list'),
  },
  screenTime: {
    sets: noArgs('screenTime.sets'),
    block: {
      parse(args, now) {
        only(args, 'screenTime.block', ['set', 'until'])
        return defined({ set: slug(args, 'set'), until: args.until === undefined ? undefined : futureDateTime(args, 'until', now) })
      },
    },
    unblock: {
      parse(args) {
        only(args, 'screenTime.unblock', ['set'])
        return { set: slug(args, 'set') }
      },
    },
    schedule: {
      parse(args) {
        only(args, 'screenTime.schedule', ['name', 'set', 'start', 'end', 'days'])
        const start = time(args, 'start')
        const end = time(args, 'end')
        if (start === end) bad('start and end must differ')
        return defined({ name: slug(args, 'name'), set: slug(args, 'set'), start, end, days: days(args) })
      },
    },
    removeSchedule: {
      parse(args) {
        only(args, 'screenTime.removeSchedule', ['name'])
        return { name: slug(args, 'name') }
      },
    },
    limit: {
      parse(args) {
        only(args, 'screenTime.limit', ['name', 'set', 'minutes', 'days'])
        return defined({
          name: slug(args, 'name'),
          set: slug(args, 'set'),
          minutes: integer(args, 'minutes', 1, MAX_LIMIT_MINUTES),
          days: days(args),
        })
      },
    },
    removeLimit: {
      parse(args) {
        only(args, 'screenTime.removeLimit', ['name'])
        return { name: slug(args, 'name') }
      },
    },
    status: noArgs('screenTime.status'),
  },
  focus: {
    status: noArgs('focus.status'),
  },
  nfc: {
    // The host adds the tag and its URL (see createDevices).
    write: {
      foreground: true,
      parse(args) {
        only(args, 'nfc.write', ['text'])
        if (args.text === undefined) return {}
        if (typeof args.text !== 'string' || !args.text) bad('text must be a non-empty string')
        if (Buffer.byteLength(args.text) > MAX_NFC_TEXT_BYTES) bad(`text must be at most ${MAX_NFC_TEXT_BYTES} bytes as UTF-8`)
        return { text: args.text }
      },
    },
    read: { foreground: true, ...noArgs('nfc.read') },
  },
  health: {
    query: {
      parse(args) {
        only(args, 'health.query', ['type', 'from', 'to', 'limit'])
        if (!(HEALTH_TYPES as readonly unknown[]).includes(args.type)) {
          bad(`type must be one of ${HEALTH_TYPES.map((t) => `"${t}"`).join(', ')}`)
        }
        const from = dateTime(args, 'from')
        const to = dateTime(args, 'to')
        if (Date.parse(from) >= Date.parse(to)) bad('from must be before to')
        return defined({
          type: args.type,
          from,
          to,
          limit: args.limit === undefined ? undefined : integer(args, 'limit', 1, MAX_HEALTH_SAMPLES),
        })
      },
    },
  },
}

export function commandSpec(capability: string, method: string): CommandSpec | undefined {
  return Object.hasOwn(COMMANDS, capability) && Object.hasOwn(COMMANDS[capability]!, method)
    ? COMMANDS[capability]![method]
    : undefined
}

export function knownMethods(): string {
  return ['notifications.send', ...Object.entries(COMMANDS).flatMap(([c, methods]) => Object.keys(methods).map((m) => `${c}.${m}`))].join(', ')
}

const NAMES: Record<string, string> = { alarms: 'Alarm', screenTime: 'Screen Time', focus: 'Focus', health: 'Health' }
const READS = new Set(['alarms.list', 'screenTime.sets', 'screenTime.status', 'focus.status', 'health.query'])

// What the person sees if the notification service extension fails or runs
// out of time before it replaces the text.
export function fallbackBody(capability: string, method: string): string {
  const name = NAMES[capability] ?? capability
  return READS.has(`${capability}.${method}`)
    ? `${name} request for this device. Open Hobwork to answer it.`
    : `${name} change for this device. Open Hobwork if it did not apply.`
}

// The prompt push for foreground commands.
export function promptAlert(project: string, method: string): { title: string; body: string } {
  return { title: method === 'write' ? 'Write an NFC tag' : 'Scan an NFC tag', body: `${project} is waiting. Tap to start.` }
}
