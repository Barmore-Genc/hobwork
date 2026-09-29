import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProjectData, type ProjectData } from '../data/project-data.ts'
import { createProject } from '../projects.ts'
import { createSecretStore, type SecretStore } from '../secrets.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

let mcp: TestMcp
let secrets: SecretStore
let data: ProjectData

beforeEach(async () => {
  mcp = await startTestMcp({
    secrets: (host) => (secrets = createSecretStore(host, randomBytes(32))),
    data: (host) => (data = createProjectData(host, { slowQueryMs: 0 })),
  })
  await createProject(mcp.host, 'filament')
})

afterEach(() => mcp.close())

test('list_secrets shows names and hosts, never values', async () => {
  expect(textOf(await mcp.call('list_secrets', { project: 'filament' }))).toContain('has no secrets. Ask the user')
  secrets.set({ project: 'filament', name: 'SPOOL_API_KEY', value: 'the-real-value', hosts: ['api.spools.example'] })
  secrets.set({ name: 'SHARED', value: 'shared-value', hosts: ['shared.example'] })
  const text = textOf(await mcp.call('list_secrets', { project: 'filament' }))
  expect(text).not.toContain('real-value')
  expect(text).not.toContain('shared-value')
  expect(JSON.parse(text)).toEqual([
    { name: 'SHARED', scope: 'global', hosts: ['shared.example'], updatedAt: expect.any(String) },
    { name: 'SPOOL_API_KEY', scope: 'project', hosts: ['api.spools.example'], updatedAt: expect.any(String) },
  ])
})

test('agents have no tool that changes secrets', async () => {
  const { tools } = await mcp.client.listTools()
  expect(tools.map((t) => t.name).filter((name) => name.includes('secret'))).toEqual(['list_secrets'])
})

test('get_project shows reachable hosts, secret names and DB warnings', async () => {
  secrets.set({ project: 'filament', name: 'SPOOL_API_KEY', value: 'the-real-value', hosts: ['api.spools.example'] })
  await data.execute({ project: 'filament' }, { statements: [{ sql: 'SELECT 1' }], transaction: false })
  const text = textOf(await mcp.call('get_project', { project: 'filament' }))
  expect(text).not.toContain('the-real-value')
  const project = JSON.parse(text)
  expect(project.egress).toEqual(['api.spools.example'])
  expect(project.secrets).toEqual(['SPOOL_API_KEY'])
  expect(project.database).toMatchObject({ sizeBytes: expect.any(Number), slowQueries: { count: 1, last: { sql: 'SELECT 1' } } })
})
