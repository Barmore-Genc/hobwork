import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createApp } from '../app.ts'
import { createDelivery, type Delivery } from '../delivery.ts'
import { pipelineVmBackend, type GuestVmOptions } from '../guest-vm.ts'
import { createGondolinSandbox } from '../sandbox/gondolin.ts'
import { imageDir, imageExists } from '../sandbox/image.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, TEST_PUBLIC_URL } from '../test-web.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from '../workspaces.ts'
import { createRuntime, type Runtime } from './runtime.ts'

// Boots real VMs, so it only runs with HOBWORK_VM_TESTS=1 (`pnpm test:vm`).
describe.runIf(process.env.HOBWORK_VM_TESTS === '1')('project runtime in VMs', { timeout: 300_000 }, () => {
  const vmOptions: GuestVmOptions = { image: imageDir(), createSandbox: createGondolinSandbox }
  const pipelineVms = pipelineVmBackend(vmOptions)
  let host: ReturnType<typeof createTestHost>
  let runtime: Runtime
  let server: Server
  let client: Client
  let base: string
  let token: string

  beforeAll(async () => {
    if (!imageExists(vmOptions.image)) throw new Error(`no guest image at ${vmOptions.image}, run images/build.sh`)
    host = createTestHost()
    const workspaces = createWorkspaceManager<ExecWorkspaceVm>(host)
    let delivery: Delivery | undefined
    runtime = createRuntime(host, {
      createSandbox: vmOptions.createSandbox,
      image: vmOptions.image,
      startBuildVm: pipelineVms.start,
      revert: (request) => delivery!.restore(request),
    })
    delivery = createDelivery(host, { workspaces, pipeline: { startVm: pipelineVms.start }, deploy: runtime.deploy })
    server = createApp(host, {
      workspaces,
      delivery,
      runtime,
      web: { publicUrl: TEST_PUBLIC_URL, allowlist: { emails: ['kaan@example.com'], subjects: [] } },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    token = createAgentToken(host.db, 'claude').token
    client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
  })

  afterAll(async () => {
    await client?.close()
    await runtime?.stop()
    await pipelineVms.stopAll()
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

  const p = { project: 'filament', branch: 'runtime' }
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/p/filament/api${path}`, { ...init, headers: { authorization: `Bearer ${token}` } })

  test('a merged route answers HTTP requests', async () => {
    await ok('create_project', { name: 'filament' })
    await ok('create_branch', p)
    const config = JSON.parse(await ok('read_file', { ...p, path: 'hobwork.json' }))
    config.routes['GET /boom/:id'] = { handler: 'src/boom.ts' }
    config.routes['GET /lights'] = { handler: 'src/lights.ts' }
    config.crons.tick = { schedule: '* * * * *', handler: 'src/tick.ts' }
    await ok('write_file', { ...p, path: 'hobwork.json', content: JSON.stringify(config, null, 2) })
    await ok('write_file', {
      ...p,
      path: 'src/boom.ts',
      content: `import type { RequestHandler } from '@hobwork/sdk'

function explode(id: string): never {
  throw new Error(\`spool \${id} exploded\`)
}

export default ((ctx) => {
  console.log('about to explode', ctx.params.id)
  explode(ctx.params.id ?? '?')
}) satisfies RequestHandler
`,
    })
    await ok('write_file', {
      ...p,
      path: 'src/tick.ts',
      content: `import type { Handler } from '@hobwork/sdk'
import { format } from 'date-fns'

export default ((ctx) => {
  ctx.log.info('tick at', format(new Date(), 'HH:mm'), ctx.invocation.manual ? 'by hand' : 'on schedule')
}) satisfies Handler
`,
    })
    // The SDK in the image has ctx.ha and the OpenRouter helper, and its errors
    // pass instanceof in the handler bundle although the runner threw them.
    await ok('write_file', {
      ...p,
      path: 'src/lights.ts',
      content: `import { HomeAssistantError, openrouter, type RequestHandler } from '@hobwork/sdk'

export default (async (ctx) => {
  const ai = typeof openrouter(ctx).json
  try {
    await ctx.ha.getState('light.kitchen')
    return { ai }
  } catch (err) {
    if (err instanceof HomeAssistantError) return { ai, code: err.code }
    throw err
  }
}) satisfies RequestHandler
`,
    })
    await ok('commit', { ...p, message: 'Add boom route and tick cron' })
    const merged = await ok('merge', { ...p, summary: 'Add boom route and tick cron' })
    expect(merged).toMatch(/^Merged runtime into main as version 2/)
    expect(merged).not.toContain('Deploying')

    const res = await api('/greeting')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: expect.stringMatching(/^Good (morning|afternoon|evening)$/) })
    expect((await fetch(`${base}/p/filament/api/greeting`)).status).toBe(401)
    expect(await (await api('/lights')).json()).toEqual({ ai: 'function', code: 'not_configured' })
  })

  test('the template UI is served with the theme to signed-in users and calls its route', async () => {
    const { cookie } = signedIn(host)
    expect((await fetch(`${base}/p/filament/`, { redirect: 'manual' })).status).toBe(401)
    const page = await fetch(`${base}/p/filament/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<base href="/p/filament/">')
    expect(html).toContain('href="/theme/theme.css"')
    expect(await (await fetch(`${base}/p/filament/spools/3`, { headers: { cookie } })).text()).toBe(html)

    const assets = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]!)
    expect(assets.some((path) => path.endsWith('.js'))).toBe(true)
    const css = assets.find((path) => path.endsWith('.css'))
    expect(css).toBeDefined()
    const styles = await (await fetch(`${base}/p/filament/${css}`, { headers: { cookie } })).text()
    // The theme mapping from @hobwork/theme in the image.
    expect(styles).toContain('var(--hw-surface)')
    for (const path of assets) expect((await fetch(`${base}/p/filament/${path}`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${base}/p/filament/handlers/src/greeting-route.js`, { headers: { cookie } })).status).toBe(404)

    // What @hobwork/sdk/browser sends from the page.
    const greeting = await fetch(`${base}/p/filament/api/greeting`, { headers: { cookie, 'x-hobwork-csrf': '1' } })
    expect(await greeting.json()).toEqual({ message: expect.stringMatching(/^Good /) })
  })

  test('crons run by hand and on schedule', async () => {
    const invoked = await ok('invoke', { project: 'filament', kind: 'cron', name: 'tick' })
    expect(invoked).toMatch(/tick at \d\d:\d\d by hand/)

    await vi.waitFor(
      async () => {
        const list = await ok('list_invocations', { project: 'filament', kind: 'cron', name: 'tick', status: 'ok' })
        expect(list).toMatch(/cron "tick" v2 ok/)
      },
      { timeout: 75_000, interval: 2000 },
    )
    const logs = await ok('get_logs', { project: 'filament', source: 'handler' })
    expect(logs).toMatch(/tick at \d\d:\d\d on schedule/)
  })

  test('an agent finds a thrown error and its stack trace through MCP', async () => {
    const res = await api('/boom/7')
    expect(res.status).toBe(500)

    const list = await ok('list_invocations', { project: 'filament', status: 'error' })
    expect(list).toContain('route "GET /boom/:id" v2 error')
    expect(list).toContain('Error: spool 7 exploded')
    const id = Number(/^#(\d+) /.exec(list)?.[1])
    const logs = await ok('get_logs', { project: 'filament', invocation_id: id })
    expect(logs).toContain('at explode (')
    expect(logs).toContain('about to explode 7')
  })

  test('restoring a version without a stored build builds it and deploys it', async () => {
    const restored = await ok('restore_version', { project: 'filament', version: 1 })
    expect(restored).toMatch(/^Restored version 1 as version 3/)
    expect(restored).not.toContain('failed')
    expect((await api('/greeting')).status).toBe(200)
    expect((await api('/boom/1')).status).toBe(404)
    // The old VM stops after the switch, in the background.
    await vi.waitFor(
      async () => {
        const events = await ok('get_logs', { project: 'filament', source: 'runtime' })
        expect(events).toContain('Runtime of version 3 started')
        expect(events).toContain('Runtime of version 2 stopped: replaced by version 3')
      },
      { timeout: 10_000, interval: 500 },
    )
  })
})
