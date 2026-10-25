import { call } from './bridge.ts'

// The options of ctx.device(name).notifications.send without actions and
// data: a notification this device shows on its own, without the host.
export type LocalNotification = {
  // Letters, digits and -_.: (at most 64). Scheduling an ID again replaces it.
  id?: string
  title: string
  body?: string
  interruptionLevel?: 'passive' | 'active' | 'timeSensitive'
  sound?: 'default' | 'none'
  // Groups this hob's notifications in Notification Center.
  thread?: string
  // A path of the hob's UI that a tap opens.
  open?: string
  // URL of an image to show on the notification banner.
  icon?: string
  // When to show it. Default: now.
  deliverAt?: Date | string
}

// Notifications on this device from a button tap, e.g. a reminder in 2 hours.
// Rejects with "denied" when notifications are turned off for Hobwork.
export const notifications = {
  schedule(notification: LocalNotification): Promise<{ id: string }> {
    const { deliverAt, ...rest } = notification
    return call('notifications', 'schedule', {
      ...rest,
      ...(deliverAt === undefined ? {} : { deliverAt: deliverAt instanceof Date ? deliverAt.toISOString() : deliverAt }),
    })
  },
  // Removes it, shown or still waiting.
  cancel: (id: string) => call<void>('notifications', 'cancel', { id }),
}
