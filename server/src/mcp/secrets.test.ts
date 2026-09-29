import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProjectData, type ProjectData } from '../data/project-data.ts'
import { createProject } from '../projects.ts'
import { queryLogs } from '../runtime/logs.ts'
import { createSecretStore, type Actor, type SecretStore } from '../secrets.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

let mcp: TestMcp
let secrets: SecretStore
let data: ProjectData
const HOST: Actor = { kind: 'host' }

beforeEach(async () => {
  mcp = await startTestMcp({
    secrets: (host) => (secrets = createSecretStore(host, randomBytes(32))),
    data: (host) => (data = createProjectData(host, { slowQueryMs: 0 })),
  })
  await createProject(mcp.host, 'filament')
  await createProject(mcp.host, 'alarms')
})

afterEach(() => mcp.close())

test('list_secrets shows the library and per project env names, never values', async () => {
  expect(textOf(await mcp.call('list_secrets'))).toContain('There are no secrets yet. Ask the user')
  expect(textOf(await mcp.call('list_secrets', { project: 'filament' }))).toContain('filament has no secrets assigned')
  secrets.create(
    { name: 'Spoolman API key', value: 'the-real-value', hosts: ['api.spools.example'], assign: { project: 'filament', envName: 'SPOOLMAN_TOKEN' } },
    HOST,
  )
  secrets.create({ name: 'Weather', value: 'weather-value', hosts: ['weather.example'] }, HOST)
  const library = textOf(await mcp.call('list_secrets'))
  expect(library).not.toContain('real-value')
  expect(library).not.toContain('weather-value')
  expect(JSON.parse(library)).toEqual([
    { name: 'Spoolman API key', hosts: ['api.spools.example'], projects: [{ project: 'filament', envName: 'SPOOLMAN_TOKEN' }] },
    { name: 'Weather', hosts: ['weather.example'], projects: [] },
  ])
  expect(JSON.parse(textOf(await mcp.call('list_secrets', { project: 'filament' })))).toEqual([
    { envName: 'SPOOLMAN_TOKEN', secret: 'Spoolman API key', hosts: ['api.spools.example'] },
  ])
})

test('agents assign and unassign existing secrets, and the project log names the agent', async () => {
  secrets.create({ name: 'Spoolman API key', value: 'v', hosts: ['api.spools.example'] }, HOST)
  const before = secrets.fingerprint('alarms')
  const assigned = await mcp.call('assign_secret', { project: 'alarms', secret: 'spoolman api key', env_name: 'API_KEY' })
  expect(textOf(assigned)).toBe(
    'Assigned "Spoolman API key" to alarms as API_KEY. Handlers can send ctx.secrets.API_KEY to api.spools.example.',
  )
  expect(secrets.forSandbox('alarms')).toEqual({ API_KEY: { value: 'v', hosts: ['api.spools.example'] } })
  expect(secrets.hosts('alarms')).toEqual(['api.spools.example'])
  expect(secrets.fingerprint('alarms')).not.toBe(before)
  expect(secrets.assigned('alarms')[0]?.assignedBy).toEqual({ kind: 'agent', name: 'claude' })

  const clash = await mcp.call('assign_secret', { project: 'alarms', secret: 'Spoolman API key', env_name: 'OTHER' })
  expect(clash.isError).toBe(true)
  expect(textOf(clash)).toContain('already assigned to this project as API_KEY')
  const missing = await mcp.call('assign_secret', { project: 'alarms', secret: 'Nope', env_name: 'NOPE' })
  expect(textOf(missing)).toContain('There is no secret called "Nope"')
  const reserved = await mcp.call('assign_secret', { project: 'filament', secret: 'Spoolman API key', env_name: 'NODE_OPTIONS' })
  expect(textOf(reserved)).toContain('reserved')

  expect(textOf(await mcp.call('unassign_secret', { project: 'alarms', env_name: 'API_KEY' }))).toBe('Unassigned API_KEY from alarms.')
  expect(secrets.forSandbox('alarms')).toEqual({})
  expect(secrets.hosts('alarms')).toEqual([])
  expect(secrets.fingerprint('alarms')).toBe(before)
  expect((await mcp.call('unassign_secret', { project: 'alarms', env_name: 'API_KEY' })).isError).toBe(true)
  expect(secrets.get('Spoolman API key')).toBeDefined()

  expect(queryLogs(mcp.host, { project: 'alarms', eventsOnly: true, limit: 10 }).map((l) => [l.event, l.message])).toEqual([
    ['secret', 'Agent claude added the secret "Spoolman API key" as API_KEY. It is only sent to api.spools.example'],
    ['secret', 'Agent claude removed the secret "Spoolman API key" (API_KEY)'],
  ])
})

test('no tool lets an agent create secrets or set values or hosts', async () => {
  const { tools } = await mcp.client.listTools()
  const secretTools = tools.filter((t) => t.name.includes('secret'))
  expect(secretTools.map((t) => t.name).sort()).toEqual(['assign_secret', 'list_secrets', 'unassign_secret'])
  for (const tool of secretTools) {
    expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).not.toContain('value')
    expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).not.toContain('hosts')
  }

  secrets.create({ name: 'Key', value: 'v', hosts: ['a.example'] }, HOST)
  await mcp.call('assign_secret', { project: 'filament', secret: 'Key', env_name: 'KEY', hosts: ['evil.example'], value: 'x' })
  expect(secrets.forSandbox('filament')).toEqual({ KEY: { value: 'v', hosts: ['a.example'] } })
})

test('get_project shows reachable hosts, secret env names and DB warnings', async () => {
  secrets.create(
    { name: 'Spools', value: 'the-real-value', hosts: ['api.spools.example'], assign: { project: 'filament', envName: 'SPOOL_API_KEY' } },
    HOST,
  )
  await data.execute({ project: 'filament' }, { statements: [{ sql: 'SELECT 1' }], transaction: false })
  const text = textOf(await mcp.call('get_project', { project: 'filament' }))
  expect(text).not.toContain('the-real-value')
  const project = JSON.parse(text)
  expect(project.egress).toEqual(['api.spools.example'])
  expect(project.secrets).toEqual(['SPOOL_API_KEY'])
  expect(project.database).toMatchObject({ sizeBytes: expect.any(Number), slowQueries: { count: 1, last: { sql: 'SELECT 1' } } })
})
