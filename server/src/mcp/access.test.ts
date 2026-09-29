import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Access } from '../access.ts'
import { createAgentToken } from '../agents.ts'
import { createProject } from '../projects.ts'
import { createSecretStore, type SecretStore } from '../secrets.ts'
import { findSshKey, generateEd25519KeyPair } from '../ssh/keys.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

let mcp: TestMcp
let secrets: SecretStore
const clients: Client[] = []

beforeEach(async () => {
  mcp = await startTestMcp({ secrets: (host) => (secrets = createSecretStore(host, randomBytes(32))), sshPort: 2222 })
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
  expect(tools).toEqual(expect.arrayContaining(['list_projects', 'get_project', 'read_file', 'get_logs', 'list_secrets']))
  for (const name of ['create_project', 'create_branch', 'write_file', 'bash', 'commit', 'merge', 'invoke', 'assign_secret', 'add_ssh_key']) {
    expect(tools).not.toContain(name)
  }
  const refused = await agent.call('create_branch', { project: 'filament', branch: 'x' })
  expect(refused.isError).toBe(true)
  expect(textOf(await agent.call('read_file', { project: 'alarms', branch: 'main', path: 'hobwork.json' }))).toContain('{')
})

test('project access hides other projects and refuses tools on them', async () => {
  const agent = await connect({ readOnly: false, projects: ['filament'] })
  expect(await agent.tools()).not.toContain('create_project')
  expect(JSON.parse(textOf(await agent.call('list_projects'))).map((p: { name: string }) => p.name)).toEqual(['filament'])

  const refused = await agent.call('create_branch', { project: 'alarms', branch: 'x' })
  expect(refused.isError).toBe(true)
  expect(textOf(refused)).toBe('This connection has no access to the project "alarms"')
  expect((await agent.call('create_branch', { project: 'filament', branch: 'x' })).isError).toBeFalsy()

  secrets.create({ name: 'Weather', value: 'v', hosts: ['weather.example'], assign: { project: 'alarms', envName: 'WEATHER' } }, { kind: 'host' })
  expect(JSON.parse(textOf(await agent.call('list_secrets')))).toEqual([{ name: 'Weather', hosts: ['weather.example'], projects: [] }])
  expect((await agent.call('list_secrets', { project: 'alarms' })).isError).toBe(true)
  expect((await agent.call('assign_secret', { project: 'alarms', secret: 'Weather', env_name: 'W' })).isError).toBe(true)
  expect((await agent.call('assign_secret', { project: 'filament', secret: 'Weather', env_name: 'W' })).isError).toBeFalsy()
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
  expect(JSON.parse(textOf(await agent.call('list_projects'))).map((p: { name: string }) => p.name)).toEqual(['spools'])
  mcp.host.db.prepare("DELETE FROM projects WHERE name = 'spools'").run()
  expect(JSON.parse(textOf(await agent.call('list_projects')))).toEqual([])
  expect((await agent.call('list_versions', { project: 'alarms' })).isError).toBe(true)
})
