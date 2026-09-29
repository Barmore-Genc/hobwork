import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createApp } from '../app.ts'
import { createDelivery, type Delivery } from '../delivery.ts'
import { createDevices } from '../devices/devices.ts'
import { pipelineVmBackend, type GuestVmOptions } from '../guest-vm.ts'
import { createGondolinSandbox } from '../sandbox/gondolin.ts'
import { imageDir, imageExists } from '../sandbox/image.ts'
import { createTestHost } from '../test-host.ts'
import { sendTo, signedIn, TEST_APPS_DOMAIN, TEST_PUBLIC_URL } from '../test-web.ts'
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
    const devices = createDevices({ host })
    runtime = createRuntime(host, {
      devices,
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
      devices,
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

  const p = { hob: 'filament', branch: 'runtime' }
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/p/filament/api${path}`, { ...init, headers: { authorization: `Bearer ${token}` } })

  test('a merged route answers HTTP requests', async () => {
    await ok('create_hob', { name: 'filament' })
    await ok('create_branch', p)
    const config = JSON.parse(await ok('read_file', { ...p, path: 'hobwork.json' }))
    config.routes['GET /boom/:id'] = { handler: 'src/boom.ts' }
    config.routes['GET /lights'] = { handler: 'src/lights.ts' }
    config.crons = { tick: { schedule: '* * * * *', handler: 'src/tick.ts' } }
    // The comment checks that the host, the build and the icon renderer all accept JSONC.
    const content = `// Added by the runtime test.\n${JSON.stringify(config, null, 2)}`
    await ok('write_file', { ...p, path: 'hobwork.json', content })
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
    // The SDK in the image has ctx.ha, ctx.device and the OpenRouter helper,
    // and its errors pass instanceof in the handler bundle although the runner
    // threw them.
    await ok('write_file', {
      ...p,
      path: 'src/lights.ts',
      content: `import { DeviceError, HomeAssistantError, openrouter, type RequestHandler } from '@hobwork/sdk'

export default (async (ctx) => {
  const ai = typeof openrouter(ctx).json
  const devices = await ctx.devices()
  let device: string | undefined
  try {
    await ctx.device('kaan-iphone').notifications.send({ title: 'Lights' })
  } catch (err) {
    if (err instanceof DeviceError) device = err.code
    else throw err
  }
  try {
    await ctx.ha.getState('light.kitchen')
    return { ai, devices, device }
  } catch (err) {
    if (err instanceof HomeAssistantError) return { ai, devices, device, code: err.code }
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
    expect(await (await api('/lights')).json()).toEqual({ ai: 'function', devices: [], device: 'unknown_device', code: 'not_configured' })
  })

  test('the template UI opens on its app origin through the sign-in redirects and calls its route', async () => {
    const { cookie } = signedIn(host)
    const origin = `http://filament.${TEST_APPS_DOMAIN}`
    const send = (url: string, headers: Record<string, string> = {}) => sendTo(base, url, { headers })
    const page = { accept: 'text/html' }

    // Signed out of the app: to Hobwork, which hands the session over with a code.
    const start = await send(`${origin}/spools/3`, page)
    expect(start.status).toBe(302)
    const handoff = new URL(start.headers.location!)
    expect(handoff.pathname).toBe('/auth/app')
    const toApp = await send(handoff.href, { cookie })
    expect(toApp.status).toBe(302)
    const exchanged = await send(toApp.headers.location!)
    expect(exchanged.headers.location).toBe('/spools/3')
    const appCookie = exchanged.headers['set-cookie']![0]!.split(';')[0]!

    const index = await send(`${origin}/spools/3`, { ...page, cookie: appCookie })
    expect(index.status).toBe(200)
    expect(index.headers['content-security-policy']).toBe(`frame-ancestors ${TEST_PUBLIC_URL}`)
    const html = index.body
    expect(html).toContain('<base href="/">')
    expect(html).toContain('href="/theme/theme.css"')
    expect((await send(`${origin}/theme/theme.css`)).status).toBe(200)
    // The template's emoji icon, rendered in the pipeline VM.
    expect(html).toContain('<link rel="apple-touch-icon" href="/_hobwork/icons/icon-180.png">')
    const icon = await send(`${origin}/_hobwork/icons/icon-180.png`)
    expect(icon.status).toBe(200)
    expect(icon.headers['content-type']).toBe('image/png')

    const assets = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]!)
    expect(assets.some((path) => path.endsWith('.js'))).toBe(true)
    const css = assets.find((path) => path.endsWith('.css'))
    expect(css).toBeDefined()
    const styles = (await send(`${origin}/${css}`, { cookie: appCookie })).body
    // The theme mapping from @hobwork/theme in the image.
    expect(styles).toContain('var(--hw-surface)')
    for (const path of assets) expect((await send(`${origin}/${path}`, { cookie: appCookie })).status).toBe(200)
    expect((await send(`${origin}/handlers/src/greeting-route.js`, { cookie: appCookie })).status).toBe(404)

    // What @hobwork/sdk/browser sends from the page.
    const greeting = await send(`${origin}/api/greeting`, { cookie: appCookie, 'x-hobwork-csrf': '1' })
    expect(JSON.parse(greeting.body)).toEqual({ message: expect.stringMatching(/^Good /) })
    // Hobwork's own API does not take the app's session.
    expect((await send(`${TEST_PUBLIC_URL}/api/projects`, { cookie: appCookie })).status).toBe(401)
  })

  test('crons run by hand and on schedule', async () => {
    const invoked = await ok('invoke', { hob: 'filament', kind: 'cron', name: 'tick' })
    expect(invoked).toMatch(/tick at \d\d:\d\d by hand/)

    await vi.waitFor(
      async () => {
        const list = await ok('list_invocations', { hob: 'filament', kind: 'cron', name: 'tick', status: 'ok' })
        expect(list).toMatch(/cron "tick" v2 ok/)
      },
      { timeout: 75_000, interval: 2000 },
    )
    const logs = await ok('get_logs', { hob: 'filament', source: 'handler' })
    expect(logs).toMatch(/tick at \d\d:\d\d on schedule/)
  })

  test('an agent finds a thrown error and its stack trace through MCP', async () => {
    const res = await api('/boom/7')
    expect(res.status).toBe(500)

    const list = await ok('list_invocations', { hob: 'filament', status: 'error' })
    expect(list).toContain('route "GET /boom/:id" v2 error')
    expect(list).toContain('Error: spool 7 exploded')
    const id = Number(/^#(\d+) /.exec(list)?.[1])
    const logs = await ok('get_logs', { hob: 'filament', invocation_id: id })
    expect(logs).toContain('at explode (')
    expect(logs).toContain('about to explode 7')
  })

  test('restoring a version without a stored build builds it and deploys it', async () => {
    const restored = await ok('restore_version', { hob: 'filament', version: 1 })
    expect(restored).toMatch(/^Restored version 1 as version 3/)
    expect(restored).not.toContain('failed')
    expect((await api('/greeting')).status).toBe(200)
    expect((await api('/boom/1')).status).toBe(404)
    // The old VM stops after the switch, in the background.
    await vi.waitFor(
      async () => {
        const events = await ok('get_logs', { hob: 'filament', source: 'runtime' })
        expect(events).toContain('Runtime of version 3 started')
        expect(events).toContain('Runtime of version 2 stopped: replaced by version 3')
      },
      { timeout: 10_000, interval: 500 },
    )
  })

  test('a branch preview serves its own UI and routes at its origin, and its own webhook', async () => {
    const b = { hob: 'filament', branch: 'preview-ui' }
    await ok('create_branch', b)
    const app = await ok('read_file', { ...b, path: 'ui/App.tsx' })
    await ok('write_file', { ...b, path: 'ui/App.tsx', content: app.replace("This page is the hob's dashboard.", 'This is the branch preview.') })
    await ok('write_file', {
      ...b,
      path: 'src/greeting-route.ts',
      content: `import type { Handler } from '@hobwork/sdk'

export default (async () => ({ message: 'Hello from the branch' })) satisfies Handler
`,
    })
    await ok('write_file', {
      ...b,
      path: 'src/ping.ts',
      content: `import type { RequestHandler } from '@hobwork/sdk'

export default (async (ctx) => ({ pinged: await ctx.request.text() })) satisfies RequestHandler
`,
    })
    const config = JSON.parse(await ok('read_file', { ...b, path: 'hobwork.json' }))
    config.webhooks = { ping: { handler: 'src/ping.ts' } }
    await ok('write_file', { ...b, path: 'hobwork.json', content: JSON.stringify(config, null, 2) })
    await ok('commit', { ...b, message: 'Try a new greeting' })

    const { cookie } = signedIn(host)
    const origin = `http://preview-ui--filament.${TEST_APPS_DOMAIN}`
    const send = (url: string, headers: Record<string, string> = {}, init: { method?: string; body?: string } = {}) =>
      sendTo(base, url, { headers, ...init })
    const start = await send(`${origin}/`, { accept: 'text/html' })
    const handoff = new URL(start.headers.location!)
    expect(handoff.searchParams.get('branch')).toBe('preview-ui')
    const toApp = await send(handoff.href, { cookie })
    const exchanged = await send(toApp.headers.location!)
    const appCookie = exchanged.headers['set-cookie']![0]!.split(';')[0]!

    const page = await send(`${origin}/`, { accept: 'text/html', cookie: appCookie })
    expect(page.status).toBe(200)
    const scripts = [...page.body.matchAll(/src="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]!)
    const code = (await Promise.all(scripts.map(async (path) => (await send(`${origin}/${path}`, { cookie: appCookie })).body))).join('')
    expect(code).toContain('This is the branch preview.')
    const greeting = await send(`${origin}/api/greeting`, { cookie: appCookie })
    expect(JSON.parse(greeting.body)).toEqual({ message: 'Hello from the branch' })
    expect(await (await api('/greeting')).json()).toEqual({ message: expect.stringMatching(/^Good /) })

    const rotated = await ok('rotate_webhook_token', { hob: 'filament', webhook: 'ping', branch: 'preview-ui' })
    const path = /(\/hooks\/\S+)/.exec(rotated)![1]!
    expect(path).toMatch(/^\/hooks\/preview-ui--filament\/ping\//)
    const hook = await fetch(`${base}${path}`, { method: 'POST', body: 'hello' })
    expect(await hook.json()).toEqual({ pinged: 'hello' })
    const list = await ok('list_invocations', { hob: 'filament', branch: 'preview-ui' })
    expect(list).toContain('webhook "ping" branch preview-ui ok')
    expect(list).toContain('route "GET /greeting" branch preview-ui ok')
  })
})
