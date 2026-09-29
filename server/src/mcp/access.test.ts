import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Access } from '../access.ts'
import { createAgentToken } from '../agents.ts'
import { createHomeAssistant } from '../homeassistant/client.ts'
import { createProject } from '../projects.ts'
import { createSecretStore, type SecretStore } from '../secrets.ts'
import { findSshKey, generateEd25519KeyPair } from '../ssh/keys.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

let mcp: TestMcp
let secrets: SecretStore
const clients: Client[] = []

beforeEach(async () => {
  const homeAssistant = createHomeAssistant({ connection: () => undefined, logger: { info() {}, warn() {}, error() {} } })
  mcp = await startTestMcp({ homeAssistant, secrets: (host) => (secrets = createSecretStore(host, randomBytes(32))), sshPort: 2222 })
  await createProject(mcp.host, 'filament')
  await createProject(mcp.host, 'alarms')
})

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  await mcp.close()
})

async function connect(access: Access) {
  const { token } = createAgentToken(mcp.host.db, `agent-${clients.length}`, access)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(mcp.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  )
  clients.push(client)
  return {
    tools: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
  }
}

test('read-only access lists only the tools that read and refuses the others', async () => {
  const everything = (await mcp.client.listTools()).tools
  const agent = await connect({ readOnly: true, projects: null })
  const tools = await agent.tools()
  expect(tools).toEqual(everything.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name))
  expect(tools).toEqual(expect.arrayContaining(['list_hobs', 'get_hob', 'read_file', 'get_logs', 'list_secrets']))
  for (const name of ['create_hob', 'create_branch', 'write_file', 'bash', 'commit', 'merge', 'invoke', 'assign_secret', 'add_ssh_key']) {
    expect(tools).not.toContain(name)
  }
  const refused = await agent.call('create_branch', { hob: 'filament', branch: 'x' })
  expect(refused.isError).toBe(true)
  expect(textOf(await agent.call('read_file', { hob: 'alarms', branch: 'main', path: 'hobwork.json' }))).toContain('{')
})

test('project access hides other projects and refuses tools on them', async () => {
  const agent = await connect({ readOnly: false, projects: ['filament'] })
  expect(await agent.tools()).not.toContain('create_hob')
  expect(JSON.parse(textOf(await agent.call('list_hobs'))).map((p: { name: string }) => p.name)).toEqual(['filament'])

  const refused = await agent.call('create_branch', { hob: 'alarms', branch: 'x' })
  expect(refused.isError).toBe(true)
  expect(textOf(refused)).toBe('This connection has no access to the hob "alarms"')
  expect((await agent.call('create_branch', { hob: 'filament', branch: 'x' })).isError).toBeFalsy()

  secrets.create({ name: 'Weather', value: 'v', hosts: ['weather.example'], assign: { project: 'alarms', envName: 'WEATHER' } }, { kind: 'host' })
  expect(JSON.parse(textOf(await agent.call('list_secrets')))).toEqual([{ name: 'Weather', hosts: ['weather.example'], headers: [], hobs: [] }])
  expect((await agent.call('list_secrets', { hob: 'alarms' })).isError).toBe(true)
  expect((await agent.call('assign_secret', { hob: 'alarms', secret: 'Weather', env_name: 'W' })).isError).toBe(true)
  expect((await agent.call('assign_secret', { hob: 'filament', secret: 'Weather', env_name: 'W' })).isError).toBeFalsy()
})

test('an SSH key an agent adds has the access of the credential it used', async () => {
  const agent = await connect({ readOnly: false, projects: ['filament'] })
  const { public: publicKey } = generateEd25519KeyPair()
  expect((await agent.call('add_ssh_key', { name: 'laptop', public_key: publicKey })).isError).toBeFalsy()
  const keyData = Buffer.from(publicKey.split(' ')[1]!, 'base64')
  expect(findSshKey(mcp.host.db, keyData)?.agent.access).toEqual({ readOnly: false, projects: ['filament'] })
})

test('access follows a renamed project and ends with a deleted one', async () => {
  const agent = await connect({ readOnly: true, projects: ['filament'] })
  mcp.host.db.prepare("UPDATE projects SET name = 'spools' WHERE name = 'filament'").run()
  expect(JSON.parse(textOf(await agent.call('list_hobs'))).map((p: { name: string }) => p.name)).toEqual(['spools'])
  mcp.host.db.prepare("DELETE FROM projects WHERE name = 'spools'").run()
  expect(JSON.parse(textOf(await agent.call('list_hobs')))).toEqual([])
  expect((await agent.call('list_versions', { hob: 'alarms' })).isError).toBe(true)
})

test('credentials limited to some hobs do not see the Home Assistant tools', async () => {
  const everything = await connect({ readOnly: false, projects: null })
  const all = await everything.tools()
  expect(all).toEqual(expect.arrayContaining(['ha_list_entities', 'ha_get_state', 'ha_list_services', 'ha_history']))

  const limited = await connect({ readOnly: false, projects: ['filament'] })
  const tools = await limited.tools()
  expect(tools.filter((name) => name.startsWith('ha_'))).toEqual([])
  expect(tools).toEqual(expect.arrayContaining(['get_hob', 'update_ha_services', 'set_branch_home_assistant']))
  expect(await limited.call('ha_list_entities')).toMatchObject({ isError: true })

  const readOnly = await connect({ readOnly: true, projects: ['filament'] })
  expect((await readOnly.tools()).filter((name) => name.startsWith('ha_'))).toEqual([])
  expect((await connect({ readOnly: true, projects: null })).tools()).resolves.toContain('ha_list_entities')
})

test('update_ha_services follows hob access', async () => {
  const limited = await connect({ readOnly: false, projects: ['filament'] })
  expect((await limited.call('update_ha_services', { hob: 'alarms', add: ['light'] })).isError).toBe(true)
  expect((await limited.call('update_ha_services', { hob: 'filament', add: ['light'] })).isError).toBeFalsy()
  const readOnly = await connect({ readOnly: true, projects: null })
  expect(await readOnly.tools()).not.toContain('update_ha_services')
})
