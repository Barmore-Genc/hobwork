export type DevicePlatform = 'ios' | 'macos'

export type DeviceInfo = {
  // What ctx.device() takes, e.g. "kaan-iphone".
  name: string
  platform: DevicePlatform
  // Name of the person who paired it.
  owner: string
  // What the app on it can do and the person allowed: "notifications",
  // "alarms", "screenTime", "focus", "nfc", "health". Calls to others fail
  // with "unsupported".
  capabilities: string[]
  // Whether the app has a live connection to Hobwork right now. Notifications
  // reach devices that are not connected through push.
  connected: boolean
  lastSeenAt: string | null
}

export type NotificationAction = {
  // Handed to the trigger when tapped. Letters, digits, "-" and "_".
  id: string
  title: string
}

export type Notification = {
  title: string
  body?: string
  // Up to 4 buttons. A tap runs the project's device triggers for
  // notification actions (see NotificationActionEvent).
  actions?: NotificationAction[]
  // Any JSON (up to 4 KB), handed back with an action.
  data?: unknown
}

export type SentNotification = {
  id: string
  // app: over the app's live connection. push: through Apple's push service.
  delivery: 'app' | 'push'
}

export interface Notifications {
  send(notification: Notification): Promise<SentNotification>
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export type AlarmSettings = {
  title: string
  // A one-off alarm: an ISO date-time with a time zone, e.g. new Date(...).toISOString().
  at?: string
  // Or a local time of day, "HH:MM", repeating on days (or once, at its next
  // occurrence, without days). Exactly one of at and time.
  time?: string
  days?: Weekday[]
  // Replaces the alarm with this ID, from an earlier set.
  id?: string
}

export type Alarm = {
  id: string
  title: string
  state: 'scheduled' | 'countdown' | 'paused' | 'alerting'
  at?: string
  time?: string
  days?: Weekday[]
  seconds?: number
}

// AlarmKit alarms and countdown timers. They ring even in silent mode and
// Focus, and run without the app once set. Clock app alarms are out of reach.
// App error code: "limit_reached".
export interface Alarms {
  set(alarm: AlarmSettings): Promise<{ id: string }>
  timer(timer: { title: string; seconds: number; id?: string }): Promise<{ id: string }>
  // Unknown IDs succeed too.
  cancel(alarm: { id: string }): Promise<Record<string, never>>
  // Alarms Hobwork set.
  list(): Promise<Alarm[]>
}

// A named group of apps, categories and websites the person picked in the
// app's settings. Handlers only see counts.
export type AppSet = { name: string; apps: number; categories: number; sites: number }

export type ScreenTimeSchedule = { name: string; set: string; start: string; end: string; days?: Weekday[] }
export type ScreenTimeLimit = { name: string; set: string; minutes: number; days?: Weekday[] }

export type ScreenTimeStatus = {
  blocked: { set: string; until?: string }[]
  schedules: ScreenTimeSchedule[]
  limits: (ScreenTimeLimit & { reached: boolean })[]
}

// Screen Time shields for app sets, by the set's name (e.g. "social").
// Schedules, limits and timed blocks run on the device without the app.
// App error codes: "unknown_set", "interval_too_short".
export interface ScreenTime {
  sets(): Promise<AppSet[]>
  // Blocks the set now, until the ISO date-time until, or until unblock.
  block(block: { set: string; until?: string }): Promise<Record<string, never>>
  unblock(block: { set: string }): Promise<Record<string, never>>
  // Blocks the set from start to end ("HH:MM", local time) on days, or every
  // day. The same name replaces a schedule.
  schedule(schedule: ScreenTimeSchedule): Promise<Record<string, never>>
  removeSchedule(schedule: { name: string }): Promise<Record<string, never>>
  // Blocks the set until midnight once it was used for minutes that day.
  limit(limit: ScreenTimeLimit): Promise<Record<string, never>>
  removeLimit(limit: { name: string }): Promise<Record<string, never>>
  status(): Promise<ScreenTimeStatus>
}

// Focus modes the person gave a Hobwork Focus filter with a label (e.g.
// "work") in iOS Settings. Hobwork cannot turn a Focus on or off; changes
// arrive as FocusChangedEvent.
export interface Focus {
  // Labels of the Focus modes that are on.
  status(): Promise<{ active: string[] }>
}

export type NfcRecord = { type: 'url' | 'text' | 'other'; value: string }

// NFC tags, with the system scan sheet. It needs the app in the foreground,
// so the device shows a notification to tap first, and the call waits up to
// two minutes. App error codes: "cancelled", "not_writable", "too_small".
export interface Nfc {
  // Writes a new Hobwork tag owned by this project, plus text when given.
  // Scanning it runs the project's NfcScannedEvent triggers.
  write(tag?: { text?: string }): Promise<{ tag: string }>
  // tag is set when the tag is a Hobwork tag of this host.
  read(): Promise<{ records: NfcRecord[]; tag?: string }>
}

export type HealthType = 'sleep' | 'steps' | 'heartRate' | 'restingHeartRate' | 'activeEnergy' | 'bodyMass' | 'workouts' | 'mindfulness'

export type SleepStage = 'inBed' | 'asleep' | 'awake' | 'core' | 'deep' | 'rem'

export type HealthSample = {
  type: HealthType
  // ISO date-times.
  start: string
  end: string
  value?: number
  // count, count/min, kcal, kg or min.
  unit?: string
  stage?: SleepStage
  workoutType?: string
  // The app or device that recorded it.
  source: string
}

// HealthKit data of the types the person shares in the app's settings.
// New samples arrive as HealthSamplesEvent. App error codes: "locked" (the
// phone is locked, so Health data cannot be read), "not_shared".
export interface Health {
  // At most limit samples (default and most: 1,000) from ISO date-times from to to.
  query(query: { type: HealthType; from: string; to: string; limit?: number }): Promise<HealthSample[]>
}

// Calls go through the Hobwork host. Failures (unknown device, not reachable,
// the device's own errors) throw a DeviceError with a code and message. Calls
// other than notifications.send are commands: when the device does not answer
// in time (30 seconds, two minutes for NFC) they throw "timeout", and the
// device may still run them in the next 10 minutes.
export interface Device {
  notifications: Notifications
  alarms: Alarms
  screenTime: ScreenTime
  focus: Focus
  nfc: Nfc
  health: Health
}

// ctx.payload of a trigger declared with
// { "device": { "capability": "notifications", "event": "action" } }.
export type NotificationActionEvent = {
  device: string
  capability: 'notifications'
  event: 'action'
  notificationId: string
  action: string
  // The notification's data, when it had any.
  data?: unknown
}

// { "device": { "capability": "focus", "event": "changed" } }: a Focus mode
// with a Hobwork Focus filter turned on or off.
export type FocusChangedEvent = {
  device: string
  capability: 'focus'
  event: 'changed'
  label: string
  active: boolean
}

// { "device": { "capability": "nfc", "event": "scanned" } }: someone scanned a
// tag this project wrote. device is null when the tag was opened in a browser.
export type NfcScannedEvent = {
  device: string | null
  capability: 'nfc'
  event: 'scanned'
  tag: string
}

// { "device": { "capability": "health", "event": "samples" } }: new samples of
// a shared type, up to 500 at a time. Each sample arrives once.
export type HealthSamplesEvent = {
  device: string
  capability: 'health'
  event: 'samples'
  type: HealthType
  samples: HealthSample[]
}

export type DeviceEvent = NotificationActionEvent | FocusChangedEvent | NfcScannedEvent | HealthSamplesEvent
