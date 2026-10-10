import { call, on } from './bridge.ts'

export type NativeAlarmRepeat = { seconds: number; title?: string }

type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export type NativeTimer = {
  // Replaces the timer with this ID (a UUID). Default: a new one.
  id?: string
  title: string
  subtitle?: string
  // 1 to 86,400.
  seconds: number
  // "#RRGGBB" for the Live Activity and buttons.
  tint?: string
  // The ringing timer's second button: a new countdown with the same ID.
  repeat?: NativeAlarmRepeat
}

export type NativeAlarm = {
  id: string
  title: string
  subtitle?: string
  tint?: string
  state: 'scheduled' | 'countdown' | 'paused' | 'alerting'
  seconds?: number
  repeat?: NativeAlarmRepeat
  endsAt?: string
  at?: string
  time?: string
  days?: Weekday[]
}

export type NativeAlarmEvent = { id: string; title?: string; seconds?: number }

// AlarmKit timers and alarms on this device, like ctx.device(name).alarms but
// from a button tap. They ring in silent mode and Focus. The app asks once per
// hob before the first one, and iOS asks once for Hobwork. Errors: "denied"
// (not allowed), "unavailable" (no AlarmKit, such as on a Mac), "failed" with
// reason "limit_reached" or "unknown_alarm".
export const alarms = {
  timer: (timer: NativeTimer) => call<{ id: string }>('alarms', 'timer', timer),
  set: (alarm: { id?: string; title: string; subtitle?: string; tint?: string; at?: Date | string; time?: string; days?: Weekday[] }) =>
    call<{ id: string }>('alarms', 'set', { ...alarm, ...(alarm.at instanceof Date ? { at: alarm.at.toISOString() } : {}) }),
  // Changes a timer in place; repeat: null removes the second button.
  reschedule: (changes: Partial<Omit<NativeTimer, 'repeat'>> & { id: string; repeat?: NativeAlarmRepeat | null }) =>
    call<{ id: string }>('alarms', 'reschedule', changes),
  cancel: (id: string) => call<void>('alarms', 'cancel', { id }),
  // This hob's alarms and timers on this device.
  list: () => call<NativeAlarm[]>('alarms', 'list'),
  // A timer or alarm of this hob rang, was stopped or repeated while the page
  // is open. Handlers get the same as AlarmEvent triggers.
  on: (event: 'fired' | 'stopped' | 'repeated', listener: (alarm: NativeAlarmEvent) => void) =>
    on<NativeAlarmEvent>(`alarms.${event}`, listener),
}
