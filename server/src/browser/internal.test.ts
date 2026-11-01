import { expect, test } from 'vitest'
import { BrowserError } from '../../../packages/sdk/src/webbrowser.ts'
import { browserResponse, type BrowserAccess, type BrowserCallLog, type BrowserEndpointOptions } from './internal.ts'
import type { BrowserCall, BrowserService } from './service.ts'

type Answer = { status: number; body: { ok: boolean; result?: unknown; error?: { code: string; message: string } } }

function fakeService(options: { result?: unknown; error?: BrowserError; calls?: BrowserCall[] } = {}): BrowserService {
  return {
    async run(call) {
      options.calls?.push(call)
      if (options.error) throw options.error
      return options.result ?? null
    },
    status: () => ({ running: true, tabs: 0 }),
    tabsOf: async () => [],
    screenshotOf: async () => undefined,
    close: async () => {},
  }
}

async function call(
  request: object | string,
  options: Partial<BrowserEndpointOptions> & { browser?: BrowserService } = {},
  logged: BrowserCallLog[] = [],
): Promise<Answer> {
  const res = await browserResponse(typeof request === 'string' ? request : JSON.stringify(request), {
    project: 'filament',
    access: 'full',
    sites: () => ['shop.example.com'],
    log: (entry) => logged.push(entry),
    ...options,
  })
  return { status: res.status, body: (await res.json()) as Answer['body'] }
}

const SECRETS = { SHOP_PASSWORD: { value: 'hunter2', hosts: ['shop.example.com'] } }
const TAB = 'a1b2c3d4e5f60718'

test('without a browser the host says how to install one', async () => {
  const answer = await call({ action: 'open', url: 'https://shop.example.com/' })
  expect(answer.status).toBe(503)
  expect(answer.body).toMatchObject({ ok: false, error: { code: 'not_configured' } })
  expect(answer.body.error!.message).toContain('browser:install')
})

test('a branch preview without permission is refused and says how to allow it', async () => {
  const logged: BrowserCallLog[] = []
  const access: BrowserAccess = { branch: 'work', allowed: () => false }
  const answer = await call({ action: 'open', url: 'https://shop.example.com/', invocation: 4 }, { access, browser: fakeService() }, logged)
  expect(answer.status).toBe(403)
  expect(answer.body.error!.code).toBe('not_approved')
  expect(logged).toEqual([
    {
      invocation: 4,
      level: 'warn',
      message: expect.stringContaining('set_branch_browser'),
    },
  ])
})

test('an approved branch browses as the branch, not as the deployed version', async () => {
  const calls: BrowserCall[] = []
  const access: BrowserAccess = { branch: 'work', allowed: () => true }
  await call({ action: 'tabs' }, { access, browser: fakeService({ calls }) })
  expect(calls[0]!.session).toEqual({ project: 'filament', branch: 'work' })
})

test('results are logged with what the command was, never with typed text', async () => {
  const logged: BrowserCallLog[] = []
  await call({ action: 'text', tab: TAB, invocation: 9 }, { browser: fakeService({ result: 'hello' }), secrets: () => SECRETS }, logged)
  await call({ action: 'fill', tab: TAB, selector: 'css=#password', text: 'hunter2', invocation: 9 }, { browser: fakeService(), secrets: () => SECRETS }, logged)
  expect(logged).toEqual([
    { invocation: 9, level: 'debug', message: 'Browser: text' },
    { invocation: 9, level: 'info', message: 'Browser: fill css=#password' },
  ])
})

test('secret values never travel back to the guest', async () => {
  const page = {
    text: 'Welcome back. Your password hunter2 is wrong',
    rows: ['hunter2', 'harmless', { nested: { value: 'x hunter2 y' } }],
    count: 3,
  }
  const answer = await call({ action: 'evaluate', tab: TAB, source: '() => 1' }, { browser: fakeService({ result: page }), secrets: () => SECRETS })
  expect(answer.body.result).toEqual({
    text: 'Welcome back. Your password [redacted] is wrong',
    rows: ['[redacted]', 'harmless', { nested: { value: 'x [redacted] y' } }],
    count: 3,
  })
})

test('a refusal from the browser keeps its code and status', async () => {
  const logged: BrowserCallLog[] = []
  const answer = await call(
    { action: 'open', url: 'https://evil.com/' },
    { browser: fakeService({ error: new BrowserError('not_allowed', '"evil.com" is not one of this hob\'s browser sites') }) },
    logged,
  )
  expect(answer.status).toBe(403)
  expect(answer.body.error).toMatchObject({ code: 'not_allowed' })
  expect(logged[0]).toMatchObject({ level: 'warn' })
})

test('a bad body is refused before the browser is asked', async () => {
  const calls: BrowserCall[] = []
  for (const body of ['not json', { action: 'record', tab: TAB }, { action: 'click', tab: TAB }]) {
    const answer = await call(body, { browser: fakeService({ calls }) })
    expect(answer.status).toBe(400)
    expect(answer.body.error!.code).toBe('bad_request')
  }
  expect(calls).toEqual([])
})

test('a result too big for the guest is cut off', async () => {
  const answer = await call(
    { action: 'evaluate', tab: TAB, source: '() => 1' },
    { browser: fakeService({ result: 'x'.repeat(2 * 1024 * 1024 + 1) }) },
  )
  // The long string is one JSON string, so it is over the limit on its own.
  expect(answer.status).toBe(400)
  expect(answer.body.error!.message).toMatch(/may return/)
})
