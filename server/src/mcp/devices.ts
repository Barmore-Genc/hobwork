import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Devices } from '../devices/devices.ts'

// Agents only look devices up to write handlers against them. Pairing,
// removing and notifying are for people and deployed handlers.
export function registerDeviceTools(server: McpServer, devices: Devices): void {
  server.registerTool(
    'list_devices',
    {
      description:
        'List the phones and computers paired with Hobwork: the name handlers pass to ctx.device(name), the owner, capabilities, whether the app is connected and when it was last seen. Capabilities are what the app on the device can do and the person allowed: notifications, alarms (AlarmKit alarms and timers), screenTime (block app sets, schedules, daily limits), focus (which Focus modes are on), nfc (write Hobwork tags or any link, read tags), health (HealthKit samples). Calls to a capability a device does not list fail with "unsupported". Events (notification actions, Focus changes, NFC tag scans, Health samples, alarms that rang, were stopped or repeated) run hobwork.json triggers with a "device" block. Only deployed handlers can use devices; workspaces and branch previews cannot, so tests fake ctx.device with createTestContext.',
      annotations: { readOnlyHint: true },
    },
    () => {
      const list = devices.info()
      const text = list.length
        ? JSON.stringify(list, null, 2)
        : 'No device is paired. Ask the user to install the Hobwork app and connect it to this Hobwork host.'
      return { content: [{ type: 'text', text }] }
    },
  )
}
