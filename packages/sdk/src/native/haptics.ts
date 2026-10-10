import { call } from './bridge.ts'

export type ImpactStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'

// Haptic feedback on iPhone. Not on iPad or macOS: has('haptics') is false there.
export const haptics = {
  // Picking something up, e.g. the start of a drag.
  lift: () => call<void>('haptics', 'lift'),
  // A selection change, e.g. a drag passing over a valid target.
  tick: () => call<void>('haptics', 'tick'),
  success: () => call<void>('haptics', 'success'),
  warning: () => call<void>('haptics', 'warning'),
  error: () => call<void>('haptics', 'error'),
  // intensity is 0 to 1.
  impact: (style: ImpactStyle = 'medium', intensity?: number) =>
    call<void>('haptics', 'impact', { style, ...(intensity === undefined ? {} : { intensity }) }),
}
