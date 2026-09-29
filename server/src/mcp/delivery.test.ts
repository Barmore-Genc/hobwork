import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createApp } from '../app.ts'
import { createDelivery } from '../delivery.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { startHostWorkspaceVm } from '../test-workspace-vm.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from '../workspaces.ts'

vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>
let server: Server
let client: Client

async function start(withPipeline: boolean): Promise<void> {
  const workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, { startVm: startHostWorkspaceVm(host) })
  const delivery = createDelivery(host, {
    workspaces,
    pipeline: withPipeline ? { startVm: startHostPipelineVm } : undefined,
  })
  server = createApp(host, { workspaces, delivery })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
  const { token } = createAgentToken(host.db, 'claude')
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  )
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  return { text, isError: result.isError === true }
}

async function ok(name: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await call(name, args)
  expect(isError, text).toBe(false)
  return text
}

async function fails(name: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await call(name, args)
  expect(isError, text).toBe(true)
  return text
}

const p = { hob: 'filament' }

async function commitOnBranch(branch: string, path: string, content: string): Promise<void> {
  await ok('write_file', { ...p, branch, path, content })
  await ok('commit', { ...p, branch, message: `Change ${path}` })
}

beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
  await seedMain(host, 'filament')
})

afterEach(async () => {
  await client.close()
  await new Promise((resolve) => server.close(resolve))
  host.dispose()
})

test('merges, reports pipeline status, lists versions and restores', async () => {
  await start(true)
  await ok('create_branch', { ...p, branch: 'spools' })
  await commitOnBranch('spools', 'src/spools.ts', 'export const spools = []\n')

  const merged = await ok('merge', { ...p, branch: 'spools', summary: 'Add spools' })
  expect(merged).toMatch(/^Merged spools into main as version 2 \(commit [0-9a-f]{40}\)\. Pipeline run 1 passed\./)
  expect(merged).toContain('spools now points at the new main')

  const status = await ok('pipeline_status', { ...p, run_id: 1 })
  expect(status).toContain('Pipeline run 1 for filament (spools): passed')
  expect(status).toContain('## test: passed')
  expect(status).toContain('all tests passed')
  expect(status).toContain('## install: skipped')
  expect(await ok('pipeline_status', { ...p, branch: 'spools' })).toBe(status)

  await commitOnBranch('spools', 'package.json', fakePackageJson({ lint: "echo 'no-unused-vars in src/spools.ts'; exit 1" }))
  const failed = await fails('merge', { ...p, branch: 'spools', summary: 'Break lint' })
  expect(failed).toContain('the lint step failed in pipeline run 2. main is unchanged')
  expect(failed).toContain('no-unused-vars in src/spools.ts')
  expect(await ok('pipeline_status', p)).toContain('## lint: failed')
  expect(await fails('pipeline_status', { ...p, run_id: 99 })).toContain('does not exist')

  const versions = JSON.parse(await ok('list_versions', p))
  expect(versions.map((v: { number: number; summary: string }) => [v.number, v.summary])).toEqual([
    [2, 'Add spools'],
    [1, 'Create hob from template'],
  ])
  expect(versions[0]).toMatchObject({ agent: 'claude', pipelineRunId: 1 })

  expect(await ok('restore_version', { ...p, version: 1 })).toMatch(/^Restored version 1 as version 3 \(commit/)
  expect(await fails('read_file', { ...p, branch: 'main', path: 'src/spools.ts' })).toBeTruthy()
})

test('merge refuses without a pipeline backend', async () => {
  await start(false)
  await ok('create_branch', { ...p, branch: 'spools' })
  await commitOnBranch('spools', 'src/spools.ts', 'x\n')
  expect(await fails('merge', { ...p, branch: 'spools', summary: 'Spools' })).toContain('no pipeline VM backend')
  expect(await fails('pipeline_status', p)).toContain('No pipeline runs')
})

test('merge returns conflicting files', async () => {
  await start(true)
  for (const [branch, value] of [['one', '2'], ['two', '3']] as const) {
    await ok('create_branch', { ...p, branch })
    await commitOnBranch(branch, 'src/a.ts', `export const a = ${value}\n`)
  }
  await ok('merge', { ...p, branch: 'one', summary: 'One' })
  const conflict = await fails('merge', { ...p, branch: 'two', summary: 'Two' })
  expect(conflict).toContain('two does not apply on top of the current main. Conflicting files:\n- src/a.ts')
})
