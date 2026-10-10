import type { LiveActivity, LiveActivityChanges, LiveActivityEnd, LiveActivityEnded, LiveActivityUpdated } from '../live-activities.ts'
import { call } from './bridge.ts'

export type LiveActivityStatus = {
  // The person allows Live Activities for Hobwork.
  enabled: boolean
  // They also allow more frequent updates.
  frequentPushes: boolean
}

// Live Activities from a page in the app (iOS). start shows one on this
// device right away, e.g. the "In your hand" card after a tap; the hob's
// handlers then update and end it like one they started with
// ctx.person(id).liveActivities (the button runs its route on the host).
// update and end reach every device that shows it. Rejects with "denied" when
// Live Activities are off for Hobwork, and with "unavailable" in branch previews.
export const liveActivities = {
  status: () => call<LiveActivityStatus>('liveActivities', 'status'),
  start: (activity: LiveActivity) => call<{ id: string }>('liveActivities', 'start', activity),
  update: (id: string, changes: LiveActivityChanges) => call<LiveActivityUpdated>('liveActivities', 'update', { id, changes }),
  end: (id: string, options: LiveActivityEnd = {}) => call<LiveActivityEnded>('liveActivities', 'end', { id, ...options }),
}
