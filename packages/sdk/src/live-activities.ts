// The one button of a Live Activity. A tap runs the route on the Hobwork host
// without opening the app, with ctx.caller set to the person and device that
// tapped it.
export type LiveActivityButton = {
  // At most 24 characters, e.g. "+2 h".
  title: string
  // A path as in hobwork.json's routes, e.g. "/dryer/extend".
  route: string
  // Default POST.
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  // JSON body for the route. Default: LiveActivityButtonBody.
  body?: unknown
  // Also opens the app at the activity's open path (or the hob's home).
  opensApp?: boolean
}

// The body of a button's route when the button sets no body.
export type LiveActivityButtonBody = {
  activityId: string
  data?: unknown
}

// What a Live Activity shows on the Lock Screen and in the Dynamic Island. The
// countdown and the time-based progress bar run on the device from endsAt, so
// they need no updates.
export type LiveActivityContent = {
  // At most 64 characters, e.g. "Dryer · 65 °C".
  title: string
  // The second line, at most 120 characters, e.g. "#90 Blue, #34 Space Grey".
  subtitle?: string
  // Up to 4 "#RRGGBB" colors, shown as dots.
  swatches?: string[]
  // An SF Symbols name, e.g. "flame". Shown when there are no swatches.
  icon?: string
  // "#RRGGBB" for the countdown, the progress bar and the button.
  tint?: string
  // ISO date-time: a countdown to it and "ends 19:10".
  endsAt?: string
  // ISO date-time: with endsAt, a progress bar from startedAt to endsAt.
  startedAt?: string
  // 0 to 1: a progress bar, instead of the one from startedAt and endsAt.
  progress?: number
  // Big text instead of the countdown, at most 16 characters, e.g. "41%".
  value?: string
  // Under value, at most 32 characters, e.g. "paused".
  valueLabel?: string
  button?: LiveActivityButton
  // A path of the hob's UI that a tap on the activity opens, e.g. "/dry".
  open?: string
  // Any JSON (up to 4 KB), handed to the button's route. Never sent to devices.
  data?: unknown
  // ISO date-time after which the system shows the activity as outdated.
  staleAt?: string
  // Which activity the Dynamic Island shows when several run: the highest.
  relevance?: number
}

export type LiveActivity = LiveActivityContent & {
  // Your own ID for it, e.g. "dryer": letters, digits and "-_.:", at most 64.
  // Starting again with an ID that runs adds devices and replaces the content.
  id: string
  // iOS ends a Live Activity after 8 hours. restart (default): shortly before
  // that, Hobwork ends it and starts a fresh one with the same content, which
  // needs the app to have allowed starting Live Activities by push. Without
  // that, and with stillRunning, the activity switches to "Still running, ends
  // 06:40" without a countdown and stays on the Lock Screen up to 4 more hours.
  pastLimit?: 'restart' | 'stillRunning'
}

export type PersonLiveActivity = LiveActivity & {
  // all (default): every device of the person that allows Live Activities.
  // lastActive: only the one they used last.
  devices?: 'all' | 'lastActive'
}

// How it went on one device. queued: the device gets it shortly, once its app
// reported where to send updates, or at the next update window (see update).
// An error with code "dismissed": the person swiped it away on that device, so
// it is not shown there again until the activity ends.
export type LiveActivityDelivery =
  | { device: string; delivery: 'app' | 'push' | 'queued' }
  | { device: string; error: { code: string; message: string } }

export type StartedLiveActivity = {
  id: string
  devices: LiveActivityDelivery[]
}

export type LiveActivityEnd = {
  // The last content to show.
  content?: Partial<LiveActivityContent>
  // "now" removes it from the Lock Screen at once; an ISO date-time within 4
  // hours, then. Default: the system keeps it up to 4 hours.
  dismissAt?: string
}

// Changes merge into the current content; null removes a field.
export type LiveActivityChanges = { [K in keyof LiveActivityContent]?: LiveActivityContent[K] | null }

export type LiveActivityUpdated = { updated: boolean; devices: LiveActivityDelivery[] }

export type LiveActivityEnded = { ended: boolean; devices: LiveActivityDelivery[] }

// Updates reach devices whose app is open at once. Others get pushes, which
// iOS limits: Hobwork sends a change of anything but progress right away, and
// progress at least every 2 percent or 5 minutes, at low priority.
export interface LiveActivityControl {
  // updated is false when no device shows it.
  update(id: string, changes: LiveActivityChanges): Promise<LiveActivityUpdated>
  end(id: string, options?: LiveActivityEnd): Promise<LiveActivityEnded>
}

// ctx.device(name).liveActivities: on that device only. Throws a DeviceError
// with code "unsupported" when it does not allow Live Activities.
export interface LiveActivities extends LiveActivityControl {
  start(activity: LiveActivity): Promise<StartedLiveActivity>
}

// ctx.person(id).liveActivities: on the person's devices. update and end only
// change it on their devices.
export interface PersonLiveActivities extends LiveActivityControl {
  // Throws a DeviceError with code "unreachable" when none of their devices
  // allows Live Activities. Failures on single devices are in devices.
  start(activity: PersonLiveActivity): Promise<StartedLiveActivity>
}
