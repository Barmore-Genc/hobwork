import { call } from './bridge.ts'

export type HomeKitHome = {
  id: string
  name: string
  primary: boolean
}

export type HomeKitAccessory = {
  id: string
  name: string
  // The room's name, or null when the accessory is in no room.
  room: string | null
  // What the accessory reports as its serial number. Home Assistant's HomeKit bridge sets
  // it to the entity ID (a device trigger uses the device ID), which is how a bridged
  // accessory is matched back to Home Assistant. Null when it has none or cannot be reached.
  serialNumber: string | null
  // The name of the bridge the accessory is behind, or null when it is not bridged.
  bridge: string | null
}

// A home or accessory, or its ID.
type WithId = string | { id: string }
const idOf = (value: WithId): string => (typeof value === 'string' ? value : value.id)

// The person's Apple Home, on iPhone and iPad. The HomeKit protocol has no rooms, so a
// bridged accessory such as one from Home Assistant lands in the default room; only the
// app can move it. Reading and changing each ask the person once per hob, and iOS asks
// for Home access the first time. Reading rejects with "denied" when Home access is off.
export const homekit = {
  homes: () => call<HomeKitHome[]>('homekit', 'homes'),
  // Every accessory in a home, bridges included.
  accessories: (options: { home: WithId }) => call<HomeKitAccessory[]>('homekit', 'accessories', { home: idOf(options.home) }),
  // Moves an accessory to the room with this name, making the room when the home has none.
  assignRoom: (options: { accessory: WithId; room: string }) =>
    call<void>('homekit', 'assignRoom', { accessory: idOf(options.accessory), room: options.room }),
  // Renames an accessory in Apple Home.
  rename: (options: { accessory: WithId; name: string }) =>
    call<void>('homekit', 'rename', { accessory: idOf(options.accessory), name: options.name }),
}
