import type { LiveActivities } from './live-activities.ts'
import type { Widgets } from './widgets.ts'

export type DevicePlatform = 'ios' | 'macos'

export type DeviceInfo = {
  // What ctx.device() takes, e.g. "kaan-iphone".
  name: string
  platform: DevicePlatform
  // Name of the person who paired it.
  owner: string
  // ID of that person (Person.id).
  ownerId: number
  // What the app on it can do and the person allowed: "notifications",
  // "alarms", "focus", "nfc", "health", "homekit", "liveActivities" (the person allows
  // Live Activities for Hobwork), "widgets". Calls to others fail with
  // "unsupported".
  capabilities: string[]
  // Whether the app has a live connection to Hobwork right now. Notifications
  // reach devices that are not connected through push.
  connected: boolean
  // Last sign of the app, including pings of a connection open in the background.
  lastSeenAt: string | null
  // When the person last used it: the app came to the foreground, sent an
  // event (a notification action, a tag scan), or its web view called a hob.
  lastActiveAt: string | null
}

export type NotificationAction = {
  // Letters, digits, "-" and "_". Handed to the route or trigger when tapped.
  id: string
  title: string
  // Runs this route of the hob when tapped, without opening the app: a path
  // as in hobwork.json's routes, e.g. "/jobs/42/claim". ctx.caller is the
  // person and device that tapped. Without route and open, a tap runs the
  // hob's notification action triggers (see NotificationActionEvent).
  route?: string
  // Default POST.
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  // JSON body for the route. Default: NotificationActionBody.
  body?: unknown
  // Opens the hob in the app at this path of its UI, e.g. "/tray/3".
  open?: string
  // Opens the app at the hob's home when open is not set.
  foreground?: boolean
  // Shown in red, for actions that end or delete something.
  destructive?: boolean
}

// The body of a route an action runs when the action sets no body.
export type NotificationActionBody = {
  notificationId: string
  action: string
  data?: unknown
}

// passive: shows in the list without a sound or lighting up the screen.
// active: the default. timeSensitive: also breaks through Focus and the
// scheduled summary, for things that need someone now.
export type InterruptionLevel = 'passive' | 'active' | 'timeSensitive'

export type NotificationContent = {
  title: string
  body?: string
  // Up to 4 buttons.
  actions?: NotificationAction[]
  // Any JSON (up to 4 KB), handed back with an action.
  data?: unknown
  // Opens the hob in the app at this path of its UI when the notification is
  // tapped, e.g. "/print/problem". Default: the hob's home.
  open?: string
  // URL of an image to show on the notification banner. Hosts the project icon
  // at "/api/projects/<project>/icon?size=64" by default.
  icon?: string
}

export type Notification = NotificationContent & {
  // Your own ID for it, e.g. "print-stopped:42": letters, digits and
  // "-_.:", at most 64. Update and withdraw take it. Sending again with an ID
  // in use replaces that notification on every device. Without it, Hobwork
  // makes one up.
  id?: string
  interruptionLevel?: InterruptionLevel
  // "none" delivers it silently: no sound, still a banner. Passive
  // notifications never make a sound.
  sound?: 'default' | 'none'
  // Groups notifications in Notification Center, e.g. "printer". Default: one
  // group for the hob.
  thread?: string
  // An ISO date-time within 30 days: Hobwork holds the notification and sends
  // it then, also across restarts. Withdrawing it before then cancels it.
  deliverAt?: string
}

export type SentNotification = {
  id: string
  // app: over the app's live connection. push: through Apple's push service.
  // scheduled: held until deliverAt.
  delivery: 'app' | 'push' | 'scheduled'
}

// How it went on one device.
export type DeviceDelivery =
  | { device: string; delivery: 'app' | 'push' }
  | { device: string; error: { code: string; message: string } }

export interface Notifications {
  send(notification: Notification): Promise<SentNotification>
}

export type PersonNotification = Notification & {
  // all (default): every device of the person that shows notifications.
  // lastActive: only the one they used last (see DeviceInfo.lastActiveAt).
  devices?: 'all' | 'lastActive'
}

export type SentPersonNotification = {
  id: string
  // True while it waits for deliverAt. Devices are picked then, and devices
  // is empty.
  scheduled: boolean
  devices: DeviceDelivery[]
}

export interface PersonNotifications {
  // Throws a DeviceError with code "unreachable" when the person has no device
  // that shows notifications. Failures on single devices are in devices.
  send(notification: PersonNotification): Promise<SentPersonNotification>
}

// ctx.notifications: a sent notification by its ID, on every device it went to.
export interface NotificationControl {
  // Changes what it says in place, without a sound or banner. Devices where
  // someone tapped one of its actions keep it removed. updated is false when
  // it was withdrawn or never sent.
  update(id: string, changes: Partial<NotificationContent>): Promise<{ updated: boolean; devices: DeviceDelivery[] }>
  // Removes it from every device, within seconds for devices that are on, and
  // cancels it when it waits for deliverAt. Devices that are off or out of
  // reach remove it when the app connects again. withdrawn is false when it
  // was already withdrawn or never sent.
  withdraw(id: string): Promise<{ withdrawn: boolean }>
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

// How an alarm or timer looks on the Lock Screen, in its Live Activity and when it rings.
export type AlarmLooks = {
  // A second line under the title, e.g. "4 spools, 70 °C".
  subtitle?: string
  // "#RRGGBB" for its buttons and Live Activity. Default: Hobwork's accent color.
  tint?: string
}

// The ringing timer's second button next to Stop: tapping it starts a new
// countdown of seconds with the same ID, e.g. { seconds: 7200, title: "+2 h" }.
// Without title the button says "+2 h" from seconds.
export type AlarmRepeat = { seconds: number; title?: string }

export type AlarmSettings = AlarmLooks & {
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

export type TimerSettings = AlarmLooks & {
  title: string
  // 1 to 86,400.
  seconds: number
  repeat?: AlarmRepeat
  // Replaces the timer with this ID, from an earlier call.
  id?: string
}

// What alarms.reschedule changes; anything left out stays. repeat: null
// removes the button, e.g. once an oven run reaches its cap.
export type TimerChanges = Partial<AlarmLooks> & {
  id: string
  // A new countdown from now.
  seconds?: number
  title?: string
  repeat?: AlarmRepeat | null
}

export type Alarm = AlarmLooks & {
  id: string
  title: string
  state: 'scheduled' | 'countdown' | 'paused' | 'alerting'
  at?: string
  time?: string
  days?: Weekday[]
  // The timer's length as last set.
  seconds?: number
  repeat?: AlarmRepeat
  // When a running timer rings, as an ISO date-time.
  endsAt?: string
}

// AlarmKit alarms and countdown timers. They ring even in silent mode and
// Focus, and run without the app once set. Clock app alarms are out of reach.
// Ringing, Stop and the repeat button arrive as AlarmEvent triggers. App error
// codes: "limit_reached", "unknown_alarm" (reschedule of an ID that is gone).
export interface Alarms {
  set(alarm: AlarmSettings): Promise<{ id: string }>
  timer(timer: TimerSettings): Promise<{ id: string }>
  // Changes a timer in place, keeping its ID.
  reschedule(changes: TimerChanges): Promise<{ id: string }>
  // Unknown IDs succeed too.
  cancel(alarm: { id: string }): Promise<Record<string, never>>
  // Alarms Hobwork set.
  list(): Promise<Alarm[]>
}

// Focus modes the person gave a Hobwork Focus filter with a label (e.g.
// "work") in iOS Settings. Hobwork cannot turn a Focus on or off; changes
// arrive as FocusChangedEvent.
export interface Focus {
  // Labels of the Focus modes that are on.
  status(): Promise<{ active: string[] }>
}

export type NfcRecord = { type: 'url' | 'text' | 'other'; value: string }

// What the system scan sheet says: alertMessage while it waits ("Hold your
// iPhone near the tag on bin 4"), successMessage when done. At most 200 characters.
export type NfcSheet = { alertMessage?: string; successMessage?: string }

export type NfcWritten = {
  url: string
  // The tag's hardware ID (UID) as lowercase hex, e.g. "04a2245a8b6380" for an
  // NTAG215. Older apps leave it out.
  uid?: string
  // True when the tag read back what was written in the same tap.
  verified?: boolean
}

// NFC tags, with the system scan sheet. It needs the app in the foreground,
// so the device shows a notification to tap first, and the call waits up to
// two minutes. App error codes: "cancelled", "not_writable", "too_small",
// "verify_failed" (the tag did not read back what was written).
export interface Nfc {
  // Writes a new Hobwork tag owned by this hob, plus text when given.
  // Scanning it runs the hob's NfcScannedEvent triggers.
  write(tag?: NfcSheet & { text?: string }): Promise<NfcWritten & { tag: string }>
  // Writes any URL instead: http, https, mailto, tel, sms, facetime,
  // facetime-audio or shortcuts, at most 2,048 bytes. Scans run triggers with
  // a matching "url" prefix in every hob. Returns the URL as written.
  write(tag: NfcSheet & { url: string; text?: string }): Promise<NfcWritten>
  // tag is set when the tag is a Hobwork tag of this host, uid is the tag's
  // hardware ID (lowercase hex).
  read(sheet?: NfcSheet): Promise<{ records: NfcRecord[]; tag?: string; uid?: string }>
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
}

// HealthKit data the person allows. Types they did not allow return no
// samples: HealthKit does not tell apps which were allowed. New samples arrive
// as HealthSamplesEvent. App error codes: "locked" (the phone is locked, so
// Health data cannot be read), "not_shared" (Health is not connected).
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
  focus: Focus
  nfc: Nfc
  health: Health
  homekit: HomeKit
  liveActivities: LiveActivities
  widgets: Widgets
}

// ctx.payload of a trigger declared with
// { "device": { "capability": "notifications", "event": "action" } }, for
// actions without a route or open.
export type NotificationActionEvent = {
  device: string
  capability: 'notifications'
  event: 'action'
  // Notification.id, or the one Hobwork made up.
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
// tag this hob wrote (tag is set). With a "url" prefix on the trigger, also
// scans of any other URL starting with it, from the app's Scan Tag button or a
// Shortcut. device is null when a Hobwork tag was opened in a browser.
export type NfcScannedEvent = {
  device: string | null
  capability: 'nfc'
  event: 'scanned'
  tag?: string
  url: string
  // The tag's records, when the app read the tag itself.
  records?: NfcRecord[]
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

// { "device": { "capability": "alarms", "event": "fired" } } (or "stopped",
// "repeated"): an alarm or timer this hob set rang, someone tapped Stop, or the
// repeat button started a new countdown of seconds. The app reports fired
// when it sees the ring, which may be late (with Stop or Repeat) when iOS did
// not have the app running.
export type AlarmEvent = {
  device: string
  capability: 'alarms'
  event: 'fired' | 'stopped' | 'repeated'
  id: string
  title?: string
  // repeated: the new countdown.
  seconds?: number
}

export type DeviceEvent = NotificationActionEvent | FocusChangedEvent | NfcScannedEvent | HealthSamplesEvent | HomeKitDeviceEvent | AlarmEvent

// What the app calls ctx.device(name).homekit on a homekit-capable device.
export interface HomeKit {
  // Run an action on an accessory, room or category: "turnOn", "turnOff", "set" etc.
  // target is "accessory:<id>", "room:<id>" or "category:<id>".
  action(target: string, method: string, params?: Record<string, unknown>): Promise<never>
  // Read a property from an accessory, e.g. "state", "brightness".
  get(target: string, key: string): Promise<unknown>
  // Write a property to an accessory.
  set(target: string, key: string, value: unknown): Promise<never>
}

// { "device": { "capability": "homekit", "event": "action" } }: an accessory action
// that this hob triggered (e.g. a homekit automation). ctx.payload is HomeKitDeviceEvent.
export type HomeKitDeviceEvent = {
  device: string
  capability: 'homekit'
  event: 'action'
  target: string
  method: string
  params?: Record<string, unknown>
}
