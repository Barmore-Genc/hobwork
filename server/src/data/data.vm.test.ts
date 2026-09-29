import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createApp } from '../app.ts'
import { createDelivery, type Delivery } from '../delivery.ts'
import { pipelineVmBackend, workspaceVmBackend, type GuestVmOptions } from '../guest-vm.ts'
import { createRuntime, type Runtime } from '../runtime/runtime.ts'
import { createGondolinSandbox } from '../sandbox/gondolin.ts'
import { imageDir, imageExists } from '../sandbox/image.ts'
import { createSecretStore, type SecretStore } from '../secrets.ts'
import { createTestHost } from '../test-host.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from '../workspaces.ts'
import { createProjectData, type ProjectData } from './project-data.ts'
import { createWorkspaceEnvironment } from './workspace-environment.ts'

// A public service that echoes request headers back, so the test sees what
// left the host after secret substitution.
const ECHO_HOST = 'postman-echo.com'
const SECRET_VALUE = `hobwork-test-${randomBytes(8).toString('hex')}`

const HITS_MIGRATION = 'CREATE TABLE hits (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT;\n'

const HITS = `import type { Handler } from '@hobwork/sdk'

export default (async (ctx) => {
  await ctx.db.run('INSERT INTO hits (label) VALUES (?)', ['visit'])
  return ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM hits')
}) satisfies Handler
`

const HITS_TEST = `import { createTestContext } from '@hobwork/sdk/testing'
import { expect, test } from 'vitest'
import hits from '../src/hits.ts'

test('counts hits in a fresh test DB', async () => {
  const ctx = createTestContext()
  expect(await hits(ctx)).toEqual({ n: 1 })
  expect(await hits(ctx)).toEqual({ n: 2 })
  expect(await hits(createTestContext())).toEqual({ n: 1 })
})
`

const ECHO = `import type { Handler } from '@hobwork/sdk'

export default (async (ctx) => {
  const res = await ctx.fetch('https://${ECHO_HOST}/headers', { headers: { 'x-api-key': ctx.secrets.ECHO_KEY ?? '' } })
  const body = (await res.json()) as { headers: Record<string, string> }
  return { placeholder: ctx.secrets.ECHO_KEY, env: process.env.ECHO_KEY, echoed: body.headers['x-api-key'] }
}) satisfies Handler
`

const BLOCKED = `import type { Handler } from '@hobwork/sdk'

export default (async (ctx) => {
  const status = (url: string) => ctx.fetch(url).then((res) => res.status, (err: Error) => err.message)
  return { known: await status('https://example.com/'), unresolvable: await status('https://nothing-here.invalid/') }
}) satisfies Handler
`

// Boots real VMs, so it only runs with HOBWORK_VM_TESTS=1 (`pnpm test:vm`).
describe.runIf(process.env.HOBWORK_VM_TESTS === '1')('project DBs, secrets and egress in VMs', { timeout: 300_000 }, () => {
  let host: ReturnType<typeof createTestHost>
  let data: ProjectData
  let secrets: SecretStore
  let runtime: Runtime
  let workspaces: ReturnType<typeof createWorkspaceManager<ExecWorkspaceVm>>
  let pipelineVms: ReturnType<typeof pipelineVmBackend>
  let server: Server
  let client: Client

  beforeAll(async () => {
    const image = imageDir()
    if (!imageExists(image)) throw new Error(`no guest image at ${image}, run images/build.sh`)
    host = createTestHost()
    data = createProjectData(host)
    secrets = createSecretStore(host, randomBytes(32))
    const vmOptions: GuestVmOptions = {
      image,
      createSandbox: createGondolinSandbox,
      workspaceEnvironment: createWorkspaceEnvironment(host, { data, secrets }),
    }
    pipelineVms = pipelineVmBackend(vmOptions)
    workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, { startVm: workspaceVmBackend(vmOptions) })
    let delivery: Delivery | undefined
    runtime = createRuntime(host, {
      createSandbox: createGondolinSandbox,
      image,
      startBuildVm: pipelineVms.start,
      revert: (request) => delivery!.restore(request),
      data,
      secrets,
    })
    delivery = createDelivery(host, {
      workspaces,
      pipeline: { startVm: pipelineVms.start, migrationDryRun: data.migrationDryRun },
      deploy: runtime.deploy,
    })
    server = createApp(host, { workspaces, delivery, runtime, data, secrets })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { token } = createAgentToken(host.db, 'claude')
    client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
  })

  afterAll(async () => {
    await client?.close()
    await workspaces?.stopAll()
    await runtime?.stop()
    await pipelineVms?.stopAll()
    await data?.stop()
    server?.closeAllConnections()
    if (server) await new Promise((resolve) => server.close(resolve))
    host?.dispose()
  })

  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as CallToolResult
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    return { text, isError: result.isError === true }
  }

  async function ok(name: string, args: Record<string, unknown>): Promise<string> {
    const { text, isError } = await call(name, args)
    expect(isError, text).toBe(false)
    return text
  }

  // The JSON body of a route's response in invoke's output.
  async function route(name: string): Promise<Record<string, unknown>> {
    const text = await ok('invoke', { hob: 'filament', kind: 'route', name })
    const body = text.split('\n\n')[1] ?? ''
    return JSON.parse(body.split('\n')[0] ?? '') as Record<string, unknown>
  }

  const p = { hob: 'filament', branch: 'data' }

  test('handlers keep data in the project DB, tests get a fresh one, the workspace a copy', async () => {
    await ok('create_hob', { name: 'filament' })
    secrets.create({ name: 'Echo key', value: SECRET_VALUE, hosts: [ECHO_HOST] }, { kind: 'host' })
    await ok('assign_secret', { hob: 'filament', secret: 'Echo key', env_name: 'ECHO_KEY' })
    await ok('create_branch', p)
    const config = JSON.parse(await ok('read_file', { ...p, path: 'hobwork.json' }))
    config.routes['POST /hits'] = { handler: 'src/hits.ts' }
    config.routes['GET /echo'] = { handler: 'src/echo.ts' }
    config.routes['GET /blocked'] = { handler: 'src/blocked.ts' }
    await ok('write_file', { ...p, path: 'hobwork.json', content: JSON.stringify(config, null, 2) })
    await ok('write_file', { ...p, path: 'migrations/0001_hits.sql', content: HITS_MIGRATION })
    await ok('write_file', { ...p, path: 'src/hits.ts', content: HITS })
    await ok('write_file', { ...p, path: 'src/echo.ts', content: ECHO })
    await ok('write_file', { ...p, path: 'src/blocked.ts', content: BLOCKED })
    await ok('write_file', { ...p, path: 'tests/hits.test.ts', content: HITS_TEST })

    const checks = await ok('bash', { ...p, command: 'pnpm typecheck && pnpm lint && pnpm test', timeout_seconds: 300 })
    expect(checks, checks).toMatch(/^exit code: 0/)
    expect(checks).toMatch(/tests\/hits.test.ts .*1 test/)
    const sql = await ok('bash', { ...p, command: 'hobwork sql "INSERT INTO hits (label) VALUES (\'branch\')" && hobwork sql "SELECT label FROM hits"' })
    expect(sql).toContain('{"label":"branch"}')
    const env = await ok('bash', { ...p, command: 'echo "$ECHO_KEY"' })
    expect(env).toMatch(/GONDOLIN_SECRET_/)
    expect(env).not.toContain(SECRET_VALUE)

    await ok('commit', { ...p, message: 'Count hits, echo a secret, try blocked hosts' })
    const merged = await ok('merge', { ...p, summary: 'Count hits' })
    expect(merged, merged).toMatch(/^Merged data into main as version 2/)

    expect(await route('POST /hits')).toEqual({ n: 1 })
    expect(await route('POST /hits')).toEqual({ n: 2 })
    const project = JSON.parse(await ok('get_hob', { hob: 'filament' }))
    expect(project.database.sizeBytes).toBeGreaterThan(0)
    expect(project.egress).toEqual([ECHO_HOST])
  })

  test('a secret is substituted on the way out; the guest only sees the placeholder', async () => {
    const echoed = await route('GET /echo')
    expect(echoed.placeholder).toMatch(/^GONDOLIN_SECRET_/)
    expect(echoed.env).toBe(echoed.placeholder)
    expect(echoed.echoed).toBe(SECRET_VALUE)
  })

  test('requests to other hosts are blocked and logged, including hosts that do not resolve', async () => {
    expect(await route('GET /blocked')).toEqual({ known: 403, unresolvable: 403 })
    await vi.waitFor(async () => {
      const logs = await ok('get_logs', { hob: 'filament', source: 'runtime' })
      expect(logs).toContain('Blocked outgoing request to example.com:443')
      expect(logs).toContain('Blocked outgoing request to nothing-here.invalid:443')
    })
  })

  test('a migration that fails on production data blocks the merge', async () => {
    const b = { ...p, branch: 'unique-labels' }
    await ok('create_branch', b)
    // Passes on the empty test DB, fails on production's duplicate labels.
    const migration = 'CREATE TABLE labels (label TEXT PRIMARY KEY) STRICT;\nINSERT INTO labels SELECT label FROM hits;\n'
    await ok('write_file', { ...b, path: 'migrations/0002_labels.sql', content: migration })
    await ok('commit', { ...b, message: 'Unique labels' })
    const { text, isError } = await call('merge', { ...b, summary: 'Unique labels' })
    expect(isError, text).toBe(true)
    expect(text).toContain('the migrations step failed')
    expect(text).toContain('On a copy of the production DB: migrations/0002_labels.sql failed: UNIQUE constraint failed: labels.label')
    expect(await route('POST /hits')).toEqual({ n: 3 })
  })
})
