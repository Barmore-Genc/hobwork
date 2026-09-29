import { afterEach, beforeEach, expect, test } from 'vitest'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, requireProject } from '../projects.ts'
import { createRuntime, type Runtime } from '../runtime/runtime.ts'
import { fakeRuntimeSandboxes } from '../runtime/test-sandbox.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { recordVersion } from '../versions.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

let mcp: TestMcp
let runtime: Runtime

beforeEach(async () => {
  mcp = await startTestMcp({
    runtime: (host) =>
      (runtime = createRuntime(host, {
        createSandbox: fakeRuntimeSandboxes().factory,
        image: '/nonexistent-image',
        startBuildVm: startHostPipelineVm,
      })),
  })
  await createProject(mcp.host, 'filament')
  const commit = await seedMain(mcp.host, 'filament', {
    'package.json': fakePackageJson({ build: 'mkdir -p dist/handlers/src && cp handlers/*.js dist/handlers/src/' }),
    'hobwork.json': JSON.stringify({
      routes: { 'GET /spools/:id': { handler: 'src/spool.ts' } },
      crons: { cleanup: { schedule: '0 3 * * *', handler: 'src/cleanup.ts' } },
      webhooks: { scanned: { handler: 'src/scanned.ts' } },
      triggers: { button: { homeassistant: { trigger: 'state' }, handler: 'src/button.ts' } },
    }),
    'handlers/spool.js': `export default async (ctx) => { console.log('looking up', ctx.params.id); return { id: ctx.params.id } }`,
    'handlers/cleanup.js': `export default async () => {
      console.log('cleaning up')
      const spools = undefined
      return spools.length
    }`,
    'handlers/scanned.js': `export default async (ctx) => ({ method: ctx.request.method, body: await ctx.request.text() })`,
    'handlers/button.js': `export default async (ctx) => ctx.payload.trigger.to_state`,
  })
  const version = recordVersion(mcp.host, { projectId: requireProject(mcp.host, 'filament').id, commit, summary: 'Spools' })
  await runtime.deploy({ project: 'filament', version: version.number, commit, reason: 'merge' })
})

afterEach(() => mcp.close())

async function ok(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await mcp.call(name, args)
  expect(result.isError, textOf(result)).toBeFalsy()
  return textOf(result)
}

test('invoke runs a route and shows its response and logs', async () => {
  const text = await ok('invoke', { project: 'filament', kind: 'route', name: 'GET /spools/42' })
  expect(text).toMatch(/^Invocation \d+ \(route "GET \/spools\/:id", version 2\): ok in \d+ms/)
  expect(text).toContain('HTTP 200')
  expect(text).toContain('{"id":"42"}')
  expect(text).toContain('looking up 42')

  const missing = await mcp.call('invoke', { project: 'filament', kind: 'route', name: 'GET /nope' })
  expect(missing.isError).toBe(true)
  expect(textOf(missing)).toContain('Routes: GET /spools/:id')
})

test('invoke passes webhook bodies and trigger payloads', async () => {
  const webhook = await ok('invoke', { project: 'filament', kind: 'webhook', name: 'scanned', body: 'spool 3' })
  expect(webhook).toContain('{"method":"POST","body":"spool 3"}')
  const trigger = await ok('invoke', {
    project: 'filament',
    kind: 'trigger',
    name: 'button',
    payload: { trigger: { to_state: 'on' } },
  })
  expect(trigger).toContain('"on"')
})

test('an agent finds a thrown error and its stack trace', async () => {
  const invoked = await mcp.call('invoke', { project: 'filament', kind: 'cron', name: 'cleanup' })
  expect(invoked.isError).toBe(true)
  expect(textOf(invoked)).toContain("TypeError: Cannot read properties of undefined (reading 'length')")

  const list = await ok('list_invocations', { project: 'filament', status: 'error' })
  const id = Number(/^#(\d+) /.exec(list)?.[1])
  expect(list).toContain('cron "cleanup" v2 (manual) error')

  const logs = await ok('get_logs', { project: 'filament', invocation_id: id })
  expect(logs).toContain('at default (')
  expect(logs).toContain('cleanup.js')
  expect(logs).toContain('cleaning up')
})

test('get_logs shows runtime events and pages with after_id', async () => {
  const logs = await ok('get_logs', { project: 'filament', source: 'runtime', limit: 2 })
  expect(logs).toContain('[runtime deploy]')
  const firstId = Number(/^#(\d+) /.exec(logs)?.[1])
  const next = await ok('get_logs', { project: 'filament', after_id: firstId, limit: 1 })
  expect(next).toContain(`#${firstId + 1} `)
  expect(next).toContain(`continue with after_id ${firstId + 1}`)
})

test('tail_logs returns lines logged while it waits', async () => {
  const tail = mcp.call('tail_logs', { project: 'filament', wait_seconds: 10 })
  await new Promise((r) => setTimeout(r, 200))
  await ok('invoke', { project: 'filament', kind: 'route', name: 'GET /spools/7' })
  const text = textOf(await tail)
  expect(text).toContain('looking up 7')
  const cursor = Number(/\[cursor: (\d+)\]/.exec(text)?.[1])
  const empty = await ok('tail_logs', { project: 'filament', cursor, wait_seconds: 0 })
  expect(empty).toContain('No new log lines')
})

test('rotate_webhook_token returns a working URL path', async () => {
  const text = await ok('rotate_webhook_token', { project: 'filament', webhook: 'scanned' })
  expect(text).toMatch(/\/hooks\/filament\/scanned\/[\w-]{43}/)
})
