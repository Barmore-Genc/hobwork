import { call, type NativePlatform } from './bridge.ts'

export type AppInfo = {
  platform: NativePlatform
  appVersion: string
  bridgeVersion: number
  hob: string
  // The branch label on a branch preview, else null.
  branch: string | null
  // The name hobs use for this device, as in ctx.device(name).
  device: { name: string } | null
  // The device's owner, the same person as ctx.caller.person, or null when the
  // host cannot be reached.
  person: { id: number; name: string } | null
}

export const app = {
  info: () => call<AppInfo>('app', 'info'),
}
