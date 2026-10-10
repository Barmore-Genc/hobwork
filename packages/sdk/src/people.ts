import type { DeviceInfo, DevicePlatform } from './devices.ts'

// Someone who can sign in to Hobwork.
export type Person = {
  // Stable for the life of the host, so hob DBs can key per-person settings by
  // it. Names and emails can change.
  id: number
  name: string
  email: string | null
  // IANA time zone, e.g. "Europe/Istanbul": the one the person chose in
  // Settings, else the one their app or browser last reported, else the host's.
  timeZone: string
}

export type CallerDevice = {
  // What ctx.device() takes.
  name: string
  platform: DevicePlatform
}

// Who made a route request. Taken from the session, never from headers.
export type Caller = {
  person: Person
  // The paired app the request came from (its web view), or null for a browser.
  device: CallerDevice | null
}

// A person's devices, by person ID from ctx.people() or ctx.caller.
export interface PersonDevices {
  // Their paired devices, most recently used first. Throws a DeviceError with
  // code "unknown_person" when there is no such person.
  devices(): Promise<DeviceInfo[]>
  // The device they used last (see DeviceInfo.lastActiveAt), or undefined when
  // they have none, e.g. to send a notification where they will see it.
  lastActiveDevice(): Promise<DeviceInfo | undefined>
}

// ctx.payload of a cron with "timeZone": "person" in hobwork.json: it runs once
// for each person, at the schedule's time in their time zone.
export type PersonCronPayload = { person: Person }
