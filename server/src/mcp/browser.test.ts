import { afterEach, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { grantBranchBrowser } from '../browser/approvals.ts'
import type { BrowserCall, BrowserService } from '../browser/service.ts'
import { createProject } from '../projects.ts'
import type { ProjectConfig } from '../runtime/config.ts'
import type { Runtime } from '../runtime/runtime.ts'
import { createSecretStore, type Actor } from '../secrets.ts'
import { signedIn } from '../test-web.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

const HOST_ACTOR: Actor = { kind: 'host' }

let mcp: TestMcp | undefined

afterEach(async () => {
  await mcp?.close()
  mcp = undefined
})

function fakeBrowser(options: { results?: Record<string, unknown> } = {}) {
  const calls: BrowserCall[] = []
  const browser: BrowserService = {
    async run(call) {
      calls.push(call)
      return options.results?.[call.request.action] ?? null
    },
    status: () => ({ running: true, tabs: calls.length }),
    close: async () => {},
  }
  return { browser, calls }
}

// What a hob's committed hobwork.json declares, which is all the tools read
// from the runtime.
function fakeRuntime(sites: string[], branchSites: string[] = sites): (host: unknown) => Runtime {
  return () =>
    ({
      config: async (_project: string, branch?: string) => ({
        config: { browser: { sites: branch === undefined ? sites : branchSites } } as ProjectConfig,
        version: null,
      }),
      stop: async () => {},
    }) as unknown as Runtime
}

async function start(browser: BrowserService, runtime: (host: unknown) => Runtime, secrets?: (host: unknown) => unknown) {
  mcp = await startTestMcp({
    browser,
    runtime: runtime as never,
    setup: (host) => createProject(host, 'filament'),
    ...(secrets ? { secrets: secrets as never } : {}),
  })
  return mcp
}

test('without a browser the tools say how to install one', async () => {
  mcp = await startTestMcp({ runtime: fakeRuntime(['shop.example.com']) as never, setup: (host) => createProject(host, 'filament') })
  const result = await mcp.call('browser_open', { hob: 'filament', url: 'https://shop.example.com/' })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('browser:install')
})

test('opening a page hands the service the committed sites and the tab comes back', async () => {
  const { browser, calls } = fakeBrowser({ results: { open: { id: 'a1b2c3d4e5f60718', url: 'https://shop.example.com/', title: 'Shop' } } })
  const test = await start(browser, fakeRuntime(['shop.example.com']))
  const result = await test.call('browser_open', { hob: 'filament', url: 'https://shop.example.com/' })
  expect(textOf(result)).toBe('Tab a1b2c3d4e5f60718 at https://shop.example.com/ (Shop)')
  expect(calls[0]).toMatchObject({ session: { project: 'filament' }, sites: ['shop.example.com'], request: { action: 'open' } })
})

test('a branch needs its approval, and then acts as the branch', async () => {
  const { browser, calls } = fakeBrowser({ results: { open: { id: 'a1b2c3d4e5f60718', url: 'https://shop.example.com/', title: '' } } })
  const test = await start(browser, fakeRuntime(['shop.example.com'], ['branch.example.com']))
  // The branch has no commits, so the tools must not even look for one before
  // the approval.
  const denied = await test.call('browser_open', { hob: 'filament', url: 'https://branch.example.com/', branch: 'work' })
  expect(denied.isError).toBe(true)
  expect(textOf(denied)).toContain('set_branch_browser')
  expect(calls).toEqual([])

  grantBranchBrowser(test.host, 'filament', 'work', { userId: signedIn(test.host).user.id })

  const opened = await test.call('browser_open', { hob: 'filament', url: 'https://branch.example.com/', branch: 'work' })
  expect(opened.isError).toBeFalsy()
  expect(calls[0]).toMatchObject({ session: { project: 'filament', branch: 'work' }, sites: ['branch.example.com'] })
})

test('acting on a page builds the request the tab expects', async () => {
  const { browser, calls } = fakeBrowser()
  const test = await start(browser, fakeRuntime(['shop.example.com']))
  const tab = 'a1b2c3d4e5f60718'
  await test.call('browser_act', { hob: 'filament', tab, action: 'click', selector: 'css=#go' })
  await test.call('browser_act', { hob: 'filament', tab, action: 'fill', selector: 'css=#q', text: 'PETG' })
  await test.call('browser_act', { hob: 'filament', tab, action: 'press', key: 'Enter' })
  await test.call('browser_act', { hob: 'filament', tab, action: 'press', key: 'Tab', selector: 'css=#q' })
  await test.call('browser_act', { hob: 'filament', tab, action: 'select', selector: 'css=#size', values: ['1', '2'] })
  await test.call('browser_act', { hob: 'filament', tab, action: 'waitFor', selector: 'css=table' })
  expect(calls.map((call) => call.request)).toEqual([
    { action: 'click', tab, selector: 'css=#go' },
    { action: 'fill', tab, selector: 'css=#q', text: 'PETG' },
    { action: 'press', tab, key: 'Enter' },
    { action: 'press', tab, key: 'Tab', selector: 'css=#q' },
    { action: 'select', tab, selector: 'css=#size', values: ['1', '2'] },
    { action: 'waitFor', tab, selector: 'css=table' },
  ])

  const missing = await test.call('browser_act', { hob: 'filament', tab, action: 'fill', selector: 'css=#q' })
  expect(missing.isError).toBeFalsy()
  const noSelector = await test.call('browser_act', { hob: 'filament', tab, action: 'click' })
  expect(noSelector.isError).toBe(true)
  expect(textOf(noSelector)).toContain('click needs selector')
})

test('what an agent reads is scrubbed of secrets and cut to size', async () => {
  const { browser } = fakeBrowser({ results: { text: `Your password is hunter2 ${'x '.repeat(40_000)}` } })
  const test = await start(browser, fakeRuntime(['shop.example.com']), (host) => {
    const store = createSecretStore(host as never, randomBytes(32))
    store.create(
      { name: 'Shop', value: 'hunter2', hosts: ['shop.example.com'], assign: { project: 'filament', envName: 'SHOP_PASSWORD' } },
      HOST_ACTOR,
    )
    return store
  })
  const result = await test.call('browser_read', { hob: 'filament', tab: 'a1b2c3d4e5f60718', what: 'text' })
  const text = textOf(result)
  expect(text).toContain('Your password is [redacted]')
  expect(text).not.toContain('hunter2')
  expect(text.length).toBeLessThan(31_000)
  expect(text).toContain('characters omitted')
})

test('a screenshot comes back as an image, untouched by the scrubber', async () => {
  const jpeg = Buffer.from('bytes with hunter2 inside').toString('base64')
  const { browser } = fakeBrowser({ results: { screenshot: jpeg } })
  const test = await start(browser, fakeRuntime(['shop.example.com']), (host) => {
    const store = createSecretStore(host as never, randomBytes(32))
    store.create(
      { name: 'Shop', value: 'hunter2', hosts: ['shop.example.com'], assign: { project: 'filament', envName: 'SHOP_PASSWORD' } },
      HOST_ACTOR,
    )
    return store
  })
  const result = await test.call('browser_screenshot', { hob: 'filament', tab: 'a1b2c3d4e5f60718' })
  expect(result.content).toEqual([{ type: 'image', data: jpeg, mimeType: 'image/jpeg' }])
})

test('tabs are listed and closed, and a refusal keeps its code', async () => {
  const { browser, calls } = fakeBrowser({
    results: { tabs: [{ id: 'a1b2c3d4e5f60718', url: 'https://shop.example.com/', title: 'Shop' }] },
  })
  const test = await start(browser, fakeRuntime(['shop.example.com']))
  const listed = await test.call('browser_tabs', { hob: 'filament' })
  expect(textOf(listed)).toBe('a1b2c3d4e5f60718  https://shop.example.com/  (Shop)')
  await test.call('browser_close', { hob: 'filament', tab: 'a1b2c3d4e5f60718' })
  expect(calls.map((call) => call.request.action)).toEqual(['tabs', 'close'])

  browser.run = async () => {
    throw new Error('boom')
  }
  const failed = await test.call('browser_tabs', { hob: 'filament' })
  expect(failed.isError).toBe(true)
  expect(textOf(failed)).toContain('boom')
})
