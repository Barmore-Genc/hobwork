import { DeviceError } from './registry.ts'

// Capabilities whose calls are commands (see "Device protocol" in
// docs/architecture.md). The app checks arguments too, but a handler gets a
// clear bad_request here without waking the phone.

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export const HEALTH_TYPES = ['sleep', 'steps', 'heartRate', 'restingHeartRate', 'activeEnergy', 'bodyMass', 'workouts', 'mindfulness'] as const
export const MAX_HEALTH_SAMPLES = 1000
export const MAX_NFC_TEXT_BYTES = 1024
export const MAX_NFC_URL_BYTES = 2048
// What iOS opens from a tag without an app (background tag reading), besides
// universal links. Other schemes would only do something in an app that reads the tag.
export const NFC_URL_SCHEMES = ['http', 'https', 'mailto', 'tel', 'sms', 'facetime', 'facetime-audio', 'shortcuts'] as const
const MAX_TITLE = 100
const MAX_SUBTITLE = 200
const MAX_REPEAT_TITLE = 20
// What the NFC scan sheet shows; it has room for a few lines.
const MAX_ALERT_MESSAGE = 200
const TINT = /^#[0-9a-fA-F]{6}$/
const MAX_TIMER_SECONDS = 24 * 60 * 60
// ISO 8601 with a time zone, so "07:00" means the same on the host and the phone.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Args = Record<string, unknown>

export type CommandSpec = {
  // Needs the app (the NFC scan sheet, or AlarmKit, which only the app may
  // use), so it is sent as a push the person taps rather than one the
  // notification service extension runs.
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

function optionalText(args: Args, key: string, max: number): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) bad(`${key} must be a non-empty string`)
  if (value.length > max) bad(`${key} must be at most ${max} characters`)
  return value
}

function tint(args: Args): string | undefined {
  const value = args.tint
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !TINT.test(value)) bad('tint must be a color like "#FF9500"')
  return value.toUpperCase()
}

// The alert's second button: a new countdown of seconds with the same ID. null
// (reschedule only) removes it.
function repeat(args: Args, allowNull: boolean): { seconds: number; title?: string } | null | undefined {
  const value = args.repeat
  if (value === undefined) return undefined
  if (value === null && allowNull) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bad(`repeat must be { seconds, title? }${allowNull ? ', or null to remove the button' : ''}`)
  }
  const object = value as Args
  only(object, 'repeat', ['seconds', 'title'])
  return defined({
    seconds: integer(object, 'seconds', 1, MAX_TIMER_SECONDS, 'repeat.seconds'),
    title: optionalText(object, 'title', MAX_REPEAT_TITLE),
  }) as { seconds: number; title?: string }
}

function looks(args: Args) {
  return { subtitle: optionalText(args, 'subtitle', MAX_SUBTITLE), tint: tint(args) }
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

function integer(args: Args, key: string, min: number, max: number, name = key): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    bad(`${name} must be a whole number from ${min} to ${max}`)
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

// A URL to write to a tag, normalized the way the host compares URLs.
function nfcUrl(value: unknown): string {
  if (typeof value !== 'string' || !URL.canParse(value) || /[\s\p{Cc}]/u.test(value)) {
    bad('url must be an absolute URL without spaces, like "https://example.com/spools/3"')
  }
  const url = new URL(value)
  const scheme = url.protocol.slice(0, -1)
  if (!(NFC_URL_SCHEMES as readonly string[]).includes(scheme)) {
    bad(`url must use one of the schemes ${NFC_URL_SCHEMES.map((s) => `${s}:`).join(', ')}`)
  }
  if ((scheme === 'http' || scheme === 'https') && (url.username || url.password)) {
    bad('url must not contain a user name or password')
  }
  if (Buffer.byteLength(url.href) > MAX_NFC_URL_BYTES) bad(`url must be at most ${MAX_NFC_URL_BYTES} bytes`)
  return url.href
}

// What the system scan sheet says while it waits and once the tag is done.
function sheetMessages(args: Args) {
  return {
    alertMessage: optionalText(args, 'alertMessage', MAX_ALERT_MESSAGE),
    successMessage: optionalText(args, 'successMessage', MAX_ALERT_MESSAGE),
  }
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
      foreground: true,
      parse(args, now) {
        only(args, 'alarms.set', ['title', 'at', 'time', 'days', 'id', 'subtitle', 'tint'])
        if ((args.at === undefined) === (args.time === undefined)) {
          bad('alarms.set needs exactly one of at (a date-time, for one alarm) or time ("HH:MM", repeating on days)')
        }
        if (args.at !== undefined && args.days !== undefined) bad('days only works with time, not with at')
        return defined({
          title: title(args),
          at: args.at === undefined ? undefined : futureDateTime(args, 'at', now),
          time: args.time === undefined ? undefined : time(args, 'time'),
          days: days(args),
          ...looks(args),
          ...optionalId(args),
        })
      },
    },
    timer: {
      foreground: true,
      parse(args) {
        only(args, 'alarms.timer', ['title', 'seconds', 'id', 'subtitle', 'tint', 'repeat'])
        return defined({
          title: title(args),
          seconds: integer(args, 'seconds', 1, MAX_TIMER_SECONDS),
          ...looks(args),
          repeat: repeat(args, false),
          ...optionalId(args),
        })
      },
    },
    // Changes a timer in place: its time left, its repeat button or its text.
    reschedule: {
      foreground: true,
      parse(args) {
        only(args, 'alarms.reschedule', ['id', 'seconds', 'title', 'subtitle', 'tint', 'repeat'])
        if (args.id === undefined) bad('alarms.reschedule needs the id that alarms.timer returned')
        const changes = defined({
          seconds: args.seconds === undefined ? undefined : integer(args, 'seconds', 1, MAX_TIMER_SECONDS),
          title: args.title === undefined ? undefined : title(args),
          ...looks(args),
        })
        const button = repeat(args, true)
        if (!Object.keys(changes).length && button === undefined) bad('alarms.reschedule needs something to change: seconds, title, subtitle, tint or repeat')
        return { ...optionalId(args), ...changes, ...(button === undefined ? {} : { repeat: button }) }
      },
    },
    cancel: {
      foreground: true,
      parse(args) {
        only(args, 'alarms.cancel', ['id'])
        if (args.id === undefined) bad('alarms.cancel needs the id that alarms.set or alarms.timer returned')
        return optionalId(args)
      },
    },
    list: { foreground: true, ...noArgs('alarms.list') },
  },
  focus: {
    status: noArgs('focus.status'),
  },
  nfc: {
    // Without url, the host adds a new tag and its URL (see createDevices).
    write: {
      foreground: true,
      parse(args) {
        only(args, 'nfc.write', ['url', 'text', 'alertMessage', 'successMessage'])
        const url = args.url === undefined ? undefined : nfcUrl(args.url)
        const messages = sheetMessages(args)
        if (args.text === undefined) return defined({ url, ...messages })
        if (typeof args.text !== 'string' || !args.text) bad('text must be a non-empty string')
        if (Buffer.byteLength(args.text) > MAX_NFC_TEXT_BYTES) bad(`text must be at most ${MAX_NFC_TEXT_BYTES} bytes as UTF-8`)
        return defined({ url, text: args.text, ...messages })
      },
    },
    read: {
      foreground: true,
      parse(args) {
        only(args, 'nfc.read', ['alertMessage', 'successMessage'])
        return defined(sheetMessages(args))
      },
    },
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

const NAMES: Record<string, string> = { alarms: 'Alarm', focus: 'Focus', health: 'Health' }
const READS = new Set(['alarms.list', 'focus.status', 'health.query'])

// What the person sees if the notification service extension fails or runs
// out of time before it replaces the text.
export function fallbackBody(capability: string, method: string): string {
  const name = NAMES[capability] ?? capability
  return READS.has(`${capability}.${method}`)
    ? `${name} request for this device. Open Hobwork to answer it.`
    : `${name} change for this device. Open Hobwork if it did not apply.`
}

// The prompt push for foreground commands. from is the person's other device
// that handed the command over (the bridge's "write on my iPhone").
export function promptAlert(project: string, capability: string, method: string, args: Args, from?: string): { title: string; body: string } {
  if (capability === 'nfc' && from) {
    return {
      title: method === 'write' ? 'Write an NFC tag' : 'Scan an NFC tag',
      body: `${project} on ${from} is waiting. Tap to ${method === 'write' ? 'write the tag' : 'scan the tag'} with this device.`,
    }
  }
  if (capability === 'alarms') {
    const name = typeof args.title === 'string' ? `"${args.title}"` : undefined
    switch (method) {
      case 'set':
        return { title: 'Set an alarm', body: `${project} wants to set the alarm ${name}. Tap to set it.` }
      case 'timer':
        return { title: 'Start a timer', body: `${project} wants to start the timer ${name}. Tap to start it.` }
      case 'reschedule':
        return { title: 'Change a timer', body: `${project} wants to change a timer. Tap to change it.` }
      case 'cancel':
        return { title: 'Cancel an alarm', body: `${project} wants to cancel an alarm. Tap to cancel it.` }
      default:
        return { title: 'Check alarms', body: `${project} wants to know which alarms are set. Tap to answer.` }
    }
  }
  return { title: method === 'write' ? 'Write an NFC tag' : 'Scan an NFC tag', body: `${project} is waiting. Tap to start.` }
}
