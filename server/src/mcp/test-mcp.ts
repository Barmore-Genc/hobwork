import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createAgentToken } from '../agents.ts'
import { createApp } from '../app.ts'
import type { ProjectData } from '../data/project-data.ts'
import type { HomeAssistant } from '../homeassistant/client.ts'
import type { Host } from '../host.ts'
import type { Runtime } from '../runtime/runtime.ts'
import type { SecretStore } from '../secrets.ts'
import { createTestHost } from '../test-host.ts'

export type TestMcp = {
  host: Host
  client: Client
  call(name: string, args?: Record<string, unknown>, options?: { timeout?: number }): Promise<CallToolResult>
  close(): Promise<void>
}

export function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
}

export async function startTestMcp(
  options: {
    homeAssistant?: HomeAssistant
    runtime?: (host: Host) => Runtime
    data?: (host: Host) => ProjectData
    secrets?: (host: Host) => SecretStore
  } = {},
): Promise<TestMcp> {
  const host = createTestHost()
  const { token } = createAgentToken(host.db, 'claude')
  const runtime = options.runtime?.(host)
  const data = options.data?.(host)
  const server = createApp(host, { homeAssistant: options.homeAssistant, runtime, data, secrets: options.secrets?.(host) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  )
  return {
    host,
    client,
    async call(name, args = {}, callOptions = {}) {
      return (await client.callTool({ name, arguments: args }, undefined, callOptions)) as CallToolResult
    },
    async close() {
      await client.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await runtime?.stop()
      await data?.stop()
      host.dispose()
    },
  }
}
