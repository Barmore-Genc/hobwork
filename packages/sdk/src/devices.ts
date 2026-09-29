export type DevicePlatform = 'ios' | 'macos'

export type DeviceInfo = {
  // What ctx.device() takes, e.g. "kaan-iphone".
  name: string
  platform: DevicePlatform
  // Name of the person who paired it.
  owner: string
  // What the app on it can do, e.g. ["notifications"].
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

// Calls go through the Hobwork host. Failures (unknown device, not reachable)
// throw a DeviceError with a code and message.
export interface Device {
  notifications: Notifications
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
