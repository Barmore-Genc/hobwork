import { afterEach, expect, test, vi } from 'vitest'
import { BrowserError } from '../../../packages/sdk/src/webbrowser.ts'
import type { EngineFactory, EngineOptions, EngineTab } from './engine.ts'
import { createBrowserService, type BrowserCall } from './service.ts'
import { loadBrowserSettings } from './settings.ts'

const SHOP = 'https://shop.example.com'

class FakeTab implements EngineTab {
  current = 'about:blank'
  calls: string[] = []
  closed = 0
  // Resolves the commands that are waiting, for the queue test.
  hold: Promise<void> | undefined
  failing: Error | undefined

  async #run(call: string) {
    this.calls.push(call)
    if (this.hold) await this.hold
    if (this.failing) throw this.failing
  }

  async goto(url: string) {
    this.current = url
    await this.#run(`goto ${url}`)
  }
  async back() {
    await this.#run('back')
  }
  async reload() {
    await this.#run('reload')
  }
  async click(selector: string) {
    await this.#run(`click ${selector}`)
  }
  async hover(selector: string) {
    await this.#run(`hover ${selector}`)
  }
  async fill(selector: string, text: string) {
    await this.#run(`fill ${selector} ${text}`)
  }
  async type(selector: string, text: string) {
    await this.#run(`type ${selector} ${text}`)
  }
  async press(key: string, selector: string | undefined) {
    await this.#run(`press ${key} ${selector ?? ''}`)
  }
  async select(selector: string, values: string[]) {
    await this.#run(`select ${selector} ${values.join(',')}`)
  }
  async waitFor(selector: string) {
    await this.#run(`waitFor ${selector}`)
  }
  async text() {
    await this.#run('text')
    return 'body text'
  }
  async html() {
    await this.#run('html')
    return '<html></html>'
  }
  async evaluate(source: string, arg: unknown, world: 'isolated' | 'main') {
    await this.#run(`evaluate ${world} ${source} ${JSON.stringify(arg)}`)
    return { arg, world }
  }
  url() {
    return this.current
  }
  async title() {
    return 'A shop'
  }
  async close() {
    this.closed += 1
  }
}

class FakeBrowser {
  options: EngineOptions | undefined
  tabs: FakeTab[] = []
  closes = 0
  starts = 0

  factory: EngineFactory = async (options) => {
    this.options = options
    this.starts += 1
    return {
      open: async () => {
        const tab = new FakeTab()
        this.tabs.push(tab)
        return tab
      },
      close: async () => {
        this.closes += 1
      },
    }
  }
}

const settings = (env: NodeJS.ProcessEnv = {}) =>
  loadBrowserSettings('/tmp/hobwork-browser-test', { HOBWORK_BROWSER_HEADLESS: '1', HOBWORK_BROWSER_IDLE: '1h', ...env })

function setUp(browser: FakeBrowser, env: NodeJS.ProcessEnv = {}) {
  return createBrowserService({ settings: settings(env), engine: browser.factory, log: () => {} })
}

const call = (request: object, extra: Partial<BrowserCall> = {}): BrowserCall => ({
  session: { project: 'filament' },
  sites: ['shop.example.com'],
  request: request as BrowserCall['request'],
  ...extra,
})

async function refusal(work: Promise<unknown>): Promise<BrowserError> {
  const err = await work.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(err).toBeInstanceOf(BrowserError)
  return err as BrowserError
}

afterEach(() => {
  vi.useRealTimers()
})

test('opens a tab, lists it, and runs commands on it', async () => {
  const browser = new FakeBrowser()
  const service = setUp(browser)
  const tab = (await service.run(call({ action: 'open', url: `${SHOP}/orders` }))) as { id: string; url: string; title: string }
  expect(tab).toEqual({ id: expect.stringMatching(/^[a-f0-9]{16}$/), url: `${SHOP}/orders`, title: 'A shop' })
  expect(browser.starts).toBe(1)

  await service.run(call({ action: 'click', tab: tab.id, selector: 'css=#go' }))
  await service.run(call({ action: 'fill', tab: tab.id, selector: 'css=#email', text: 'me@example.com' }))
  expect(browser.tabs[0]!.calls).toEqual([
    `goto ${SHOP}/orders`,
    'click css=#go',
    'fill css=#email me@example.com',
  ])

  const tabs = (await service.run(call({ action: 'tabs' }))) as { id: string; url: string }[]
  expect(tabs).toEqual([{ id: tab.id, url: `${SHOP}/orders`, title: 'A shop' }])
  expect(service.status()).toMatchObject({ running: true, tabs: 1 })
  await service.close()
  expect(browser.closes).toBe(1)
})

test('a tab belongs to the hob that opened it', async () => {
  const browser = new FakeBrowser()
  const service = setUp(browser)
  const tab = (await service.run(call({ action: 'open', url: SHOP }))) as { id: string }

  const other = call({ action: 'click', tab: tab.id, selector: '#a' }, { session: { project: 'spools' } })
  expect((await refusal(service.run(other))).code).toBe('tab_gone')
  // Nor does another branch of the same hob see it.
  const branch = call({ action: 'click', tab: tab.id, selector: '#a' }, { session: { project: 'filament', branch: 'work' } })
  expect((await refusal(service.run(branch))).code).toBe('tab_gone')
  // The other hob has no tabs at all.
  expect(await service.run(call({ action: 'tabs' }, { session: { project: 'spools' } }))).toEqual([])
  await service.close()
})

test('an undeclared site never reaches the browser', async () => {
  const browser = new FakeBrowser()
  const service = setUp(browser)
  const err = await refusal(service.run(call({ action: 'open', url: 'https://evil.com/' })))
  expect(err.code).toBe('not_allowed')
  expect(err.message).toMatch(/browser.sites/)
  expect(browser.starts).toBe(0)
  await service.close()
})

test('a tab keeps its sites, and the next call may widen them', async () => {
  const browser = new FakeBrowser()
  const service = setUp(browser)
  const tab = (await service.run(call({ action: 'open', url: SHOP }))) as { id: string }
  const engineTab = browser.tabs[0]!
  const problem = browser.options!.navigationProblem(new URL('https://evil.com/'), engineTab)
  expect(problem).toMatch(/is not one of this hob's browser sites/)
  expect(browser.options!.navigationProblem(new URL(`${SHOP}/x`), engineTab)).toBeUndefined()

  // A commit that adds the host applies to tabs that are already open.
  await service.run(call({ action: 'text', tab: tab.id }, { sites: ['shop.example.com', 'evil.com'] }))
  expect(browser.options!.navigationProblem(new URL('https://evil.com/'), engineTab)).toBeUndefined()
  await service.close()
})

test('too many tabs are refused', async () => {
  const browser = new FakeBrowser()
  const service = createBrowserService({
    settings: settings({ HOBWORK_BROWSER_MAX_TABS: '2' }),
    engine: browser.factory,
  })
  await service.run(call({ action: 'open', url: `${SHOP}/1` }))
  await service.run(call({ action: 'open', url: `${SHOP}/2` }))
  const err = await refusal(service.run(call({ action: 'open', url: `${SHOP}/3` })))
  expect(err.code).toBe('too_many_tabs')
  await service.close()
})

test('a secret is typed only into the hosts it is bound to', async () => {
  const browser = new FakeBrowser()
  const service = setUp(browser)
  const tab = (await service.run(call({ action: 'open', url: `${SHOP}/login` }))) as { id: string }
  const secrets = { SHOP_PASSWORD: { value: 'hunter2', hosts: ['shop.example.com'] } }

  await service.run(
    call({ action: 'fill', tab: tab.id, selector: '#password', text: 'p-hunter2', secrets: { SHOP_PASSWORD: 'p-hunter2' } }, { secrets }),
  )
  expect(browser.tabs[0]!.calls).toContain('fill #password hunter2')

  const elsewhere = { SHOP_PASSWORD: { value: 'hunter2', hosts: ['other.example.com'] } }
  const err = await refusal(
    service.run(
      call({ action: 'fill', tab: tab.id, selector: '#password', text: 'p-hunter2', secrets: { SHOP_PASSWORD: 'p-hunter2' } }, {
        secrets: elsewhere,
      }),
    ),
  )
  expect(err.code).toBe('not_allowed')
  expect(err.message).toMatch(/does not send SHOP_PASSWORD to shop.example.com/)
  expect(browser.tabs[0]!.calls).not.toContain('fill #password hunter2 hunter2')
  await service.close()
})

test('a selector that times out says so', async () => {
  const browser = new FakeBrowser()
  const service = setUp(browser)
  const tab = (await service.run(call({ action: 'open', url: SHOP }))) as { id: string }
  const timeout = Object.assign(new Error('Timeout 30000ms exceeded.'), { name: 'TimeoutError' })
  browser.tabs[0]!.failing = timeout
  expect((await refusal(service.run(call({ action: 'click', tab: tab.id, selector: '#a' })))).code).toBe('selector_timeout')

  browser.tabs[0]!.failing = Object.assign(new Error('Timeout 30000ms exceeded.'), { name: 'TimeoutError' })
  expect((await refusal(service.run(call({ action: 'goto', tab: tab.id, url: `${SHOP}/slow` })))).code).toBe('timeout')

  browser.tabs[0]!.failing = new Error('Target page, context or browser has been closed')
  expect((await refusal(service.run(call({ action: 'text', tab: tab.id })))).code).toBe('crashed')
  await service.close()
})

test('commands for one tab queue, and a full queue answers busy', async () => {
  const browser = new FakeBrowser()
  const service = setUp(browser)
  const tab = (await service.run(call({ action: 'open', url: SHOP }))) as { id: string }
  let release: () => void = () => {}
  browser.tabs[0]!.hold = new Promise((resolve) => {
    release = resolve
  })
  const running = [1, 2, 3, 4].map((n) => service.run(call({ action: 'click', tab: tab.id, selector: `#${n}` })))
  expect((await refusal(service.run(call({ action: 'click', tab: tab.id, selector: '#5' })))).code).toBe('busy')
  release()
  await Promise.all(running)
  // The open's navigation plus the four clicks.
  expect(browser.tabs[0]!.calls).toHaveLength(5)
  await service.close()
})

test('a crash is forgotten, and the next call starts again', async () => {
  const browser = new FakeBrowser()
  const service = setUp(browser)
  const tab = (await service.run(call({ action: 'open', url: SHOP }))) as { id: string }
  browser.options!.onClosed('The browser crashed')
  expect(service.status().running).toBe(false)
  expect((await refusal(service.run(call({ action: 'text', tab: tab.id })))).code).toBe('tab_gone')
  await service.run(call({ action: 'open', url: SHOP }))
  expect(browser.starts).toBe(2)
  await service.close()
})

test('an idle browser stops after the timeout', async () => {
  vi.useFakeTimers()
  const browser = new FakeBrowser()
  const service = createBrowserService({
    settings: settings({ HOBWORK_BROWSER_IDLE: '2s' }),
    engine: browser.factory,
  })
  await service.run(call({ action: 'open', url: SHOP }))
  expect(service.status().running).toBe(true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(service.status()).toMatchObject({ running: false, tabs: 0 })
  expect(browser.closes).toBe(1)
  await service.close()
})

test('the browser is off when the host turns it off, and without one installed', async () => {
  const off = createBrowserService({ settings: settings({ HOBWORK_BROWSER: 'off' }), engine: new FakeBrowser().factory })
  expect((await refusal(off.run(call({ action: 'open', url: SHOP })))).code).toBe('not_configured')
  await off.close()

  // No engine injected, and no browser where the settings say.
  const bare = createBrowserService({ settings: settings({ HOBWORK_BROWSER_EXECUTABLE: '/nonexistent/chrome' }) })
  const err = await refusal(bare.run(call({ action: 'open', url: SHOP })))
  expect(err.code).toBe('not_configured')
  expect(err.message).toMatch(/browser:install/)
  await bare.close()
})
