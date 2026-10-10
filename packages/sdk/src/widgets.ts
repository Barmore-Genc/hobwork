import type { DeviceDelivery } from './devices.ts'

// What the route named by "widget" in hobwork.json returns for a Home Screen
// or Lock Screen widget. ctx.caller is the person whose device shows it.
export type WidgetContent = {
  // At most 64 characters.
  title: string
  // At most 120 characters.
  subtitle?: string
  // Up to 6. Small widgets and the Lock Screen show the first few.
  lines?: WidgetLine[]
  // Up to 8 "#RRGGBB" colors, shown as dots next to the title.
  swatches?: string[]
  // A path of the hob's UI that a tap opens. Default: the hob's home.
  open?: string
  // ISO date-time of the next refresh, at least 5 minutes ahead. Default: 30
  // minutes. ctx.person(id).widgets.reload() refreshes sooner.
  refreshAt?: string
}

export type WidgetLine = {
  // At most 80 characters.
  text: string
  // Right-aligned, at most 40 characters, e.g. "ends 19:10".
  detail?: string
  // Up to 4 "#RRGGBB" colors before the text.
  swatches?: string[]
}

export interface Widgets {
  // Asks the device to fetch the hob's widget again now. Devices whose app is
  // closed get a background push, which iOS may delay or drop.
  reload(): Promise<{ devices: DeviceDelivery[] }>
}

// The body of the route an intent from hobwork.json's "intents" runs, from
// Shortcuts, Siri, the Action Button or Control Center. ctx.caller is the
// person and device that ran it.
export type IntentRequest = {
  intent: string
  // By parameter id: strings for "text", numbers for "number", booleans for "boolean".
  parameters: Record<string, string | number | boolean>
}

// What an intent's route may return. say is what Siri says or Shortcuts
// shows; open opens the app at this path of the hob's UI.
export type IntentResult = {
  say?: string
  open?: string
}
