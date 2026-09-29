import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Devices } from '../devices/devices.ts'

// Agents only look devices up to write handlers against them. Pairing,
// removing and notifying are for people and deployed handlers.
export function registerDeviceTools(server: McpServer, devices: Devices): void {
  server.registerTool(
    'list_devices',
    {
      description:
        'List the phones and computers paired with Hobwork: the name handlers pass to ctx.device(name), the owner, capabilities (e.g. "notifications"), whether the app is connected and when it was last seen. Only deployed handlers can use devices; workspaces and branch previews cannot, so tests fake ctx.device with createTestContext.',
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
