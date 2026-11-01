import { existsSync, mkdirSync } from 'node:fs'
import type { BrowserContext, Page } from 'patchright'
import { BROWSER_MAX_TEXT_CHARS } from '../../../packages/sdk/src/webbrowser.ts'
import { evaluateFunction } from './commands.ts'
import type { BrowserSettings } from './settings.ts'
import { startDisplay } from './xvfb.ts'

// What the host needs from a page. patchright's Page is adapted to this, so the
// service and its tests never touch Playwright's types.
export interface EngineTab {
  goto(url: string, timeoutMs: number): Promise<void>
  back(timeoutMs: number): Promise<void>
  reload(timeoutMs: number): Promise<void>
  click(selector: string, timeoutMs: number): Promise<void>
  hover(selector: string, timeoutMs: number): Promise<void>
  fill(selector: string, text: string, timeoutMs: number): Promise<void>
  type(selector: string, text: string, timeoutMs: number): Promise<void>
  press(key: string, selector: string | undefined, timeoutMs: number): Promise<void>
  select(selector: string, values: string[], timeoutMs: number): Promise<void>
  waitFor(selector: string, timeoutMs: number): Promise<void>
  text(timeoutMs: number): Promise<string>
  html(): Promise<string>
  evaluate(source: string, arg: unknown, world: 'isolated' | 'main'): Promise<unknown>
  url(): string
  title(): Promise<string>
  close(): Promise<void>
}

export interface Engine {
  // A new page, still on about:blank. Navigating is the caller's job, so the
  // tab is known to the navigation rules before it goes anywhere.
  open(): Promise<EngineTab>
  close(): Promise<void>
}

export type EngineOptions = {
  settings: BrowserSettings
  // Why this tab may not navigate to `url`, or undefined. Called for every
  // top-level navigation, redirects included.
  navigationProblem: (url: URL, tab: EngineTab) => string | undefined
  onBlocked: (url: string, reason: string) => void
  // The browser process is gone: it crashed or was closed behind our back.
  onClosed: (reason: string) => void
  log: (level: 'info' | 'warn', message: string) => void
}

export type EngineFactory = (options: EngineOptions) => Promise<Engine>

const UBLOCK_DIR = 'ublock-origin-lite'

// The unpacked uBlock Origin Lite build browser:install put in the data dir.
export function extensionDir(settings: BrowserSettings): string | undefined {
  const dir = `${settings.extensionsDir}/${UBLOCK_DIR}`
  return existsSync(`${dir}/manifest.json`) ? dir : undefined
}

// patchright reads PLAYWRIGHT_BROWSERS_PATH once, when its registry loads, so
// it has to be set before the import. An operator who sets it keeps it.
export function useBrowsersPath(settings: BrowserSettings): string {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()
  const path = configured === undefined || configured === '' ? settings.browsersPath : configured
  process.env.PLAYWRIGHT_BROWSERS_PATH = path
  return path
}

// Where the browser binary is, or undefined when it was never installed. Both
// patchright and the browser are optional: a host that does not use them never
// loads either.
export async function browserExecutable(settings: BrowserSettings): Promise<string | undefined> {
  useBrowsersPath(settings)
  try {
    const { chromium } = await import('patchright')
    const path = settings.executablePath ?? chromium.executablePath()
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

function text(value: string): string {
  return value.length > BROWSER_MAX_TEXT_CHARS ? `${value.slice(0, BROWSER_MAX_TEXT_CHARS)}\n… (cut)` : value
}

// The user agent says Chrome, so the browser has to be a full Chromium with a
// profile: the headless shell reports HeadlessChrome and takes no extensions.
export const patchrightEngine: EngineFactory = async (options) => {
  const { settings } = options
  useBrowsersPath(settings)
  const { chromium } = await import('patchright')
  const extension = extensionDir(settings)
  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 })
  if (settings.headless) {
    // Measured with Chrome 156 here: the full build still appends the token,
    // so headless is a fallback for a host with neither a display nor Xvfb.
    options.log(
      'warn',
      'Browser: running headless, so the user agent says HeadlessChrome. Install Xvfb on a Linux host, or run where there is a display',
    )
  }
  const display = settings.headless
    ? undefined
    : await startDisplay({ ...settings.window, log: (message) => options.log('info', message) })

  const context: BrowserContext = await chromium.launchPersistentContext(settings.profileDir, {
    headless: settings.headless,
    // A real window, not an emulated viewport, so outerWidth, screen and the
    // rest of the window geometry look like a desktop.
    viewport: null,
    locale: settings.locale,
    ...(settings.timezoneId === undefined ? {} : { timezoneId: settings.timezoneId }),
    acceptDownloads: false,
    permissions: [],
    args: [
      `--window-size=${settings.window.width},${settings.window.height}`,
      `--lang=${settings.locale}`,
      // No GPU on a server, so WebGL is SwiftShader and needs this to exist at
      // all. A software renderer is common; no WebGL at all is not.
      '--enable-unsafe-swiftshader',
      '--no-first-run',
      '--no-default-browser-check',
      ...(extension ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : []),
    ],
    ...(settings.channel === undefined ? {} : { channel: settings.channel }),
    ...(settings.executablePath === undefined ? {} : { executablePath: settings.executablePath }),
    ...(display === undefined ? {} : { env: display.env }),
  })

  const tabs = new Map<Page, EngineTab>()
  let closing = false

  async function tabOf(page: Page): Promise<EngineTab | undefined> {
    const found = tabs.get(page)
    if (found) return found
    // A popup belongs to the tab that opened it, and keeps its rules.
    const opener = await page.opener().catch(() => null)
    const owner = opener ? await tabOf(opener) : undefined
    if (owner) tabs.set(page, owner)
    return owner
  }

  function watch(page: Page): void {
    page.on('close', () => tabs.delete(page))
  }

  // Every navigation goes through here, so a hob stays on the sites it
  // declared: redirects, location.href, meta refresh and form posts included.
  // Subresources are the page's own business and are left to the browser.
  await context.route('**/*', async (route) => {
    const request = route.request()
    try {
      const frame = request.frame()
      const page = frame?.page()
      // Subresources, iframe navigations and pages nothing opened are the
      // browser's business.
      if (!request.isNavigationRequest() || !frame || !page || frame !== page.mainFrame()) {
        await route.continue()
        return
      }
      const tab = await tabOf(page)
      const url = new URL(request.url())
      if (!tab || url.protocol === 'about:') {
        await route.continue()
        return
      }
      const problem = options.navigationProblem(url, tab)
      if (problem === undefined) {
        await route.continue()
        return
      }
      options.onBlocked(url.href, problem)
      await route.abort('blockedbyclient')
    } catch {
      await route.abort('failed').catch(() => {})
    }
  })

  // A manifest v3 extension registers a service worker when it loads, which is
  // the only sign from here that uBlock Origin Lite is actually there.
  if (extension !== undefined) {
    const first = context.serviceWorkers()[0]
    const worker = first ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => undefined))
    options.log(
      worker === undefined ? 'warn' : 'info',
      worker === undefined ? 'Browser: uBlock Origin Lite did not start' : 'Browser: uBlock Origin Lite is loaded',
    )
  }

  context.on('page', (page: Page) => watch(page))
  context.on('close', () => {
    if (closing) return
    options.onClosed('The browser closed')
  })
  for (const page of context.pages()) watch(page)

  class PatchrightTab implements EngineTab {
    readonly #page: Page
    constructor(page: Page) {
      this.#page = page
    }
    async goto(url: string, timeoutMs: number) {
      await this.#page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
    }
    async back(timeoutMs: number) {
      await this.#page.goBack({ timeout: timeoutMs, waitUntil: 'domcontentloaded' })
    }
    async reload(timeoutMs: number) {
      await this.#page.reload({ timeout: timeoutMs, waitUntil: 'domcontentloaded' })
    }
    async click(selector: string, timeoutMs: number) {
      await this.#page.click(selector, { timeout: timeoutMs })
    }
    async hover(selector: string, timeoutMs: number) {
      await this.#page.hover(selector, { timeout: timeoutMs })
    }
    async fill(selector: string, value: string, timeoutMs: number) {
      await this.#page.fill(selector, value, { timeout: timeoutMs })
    }
    async type(selector: string, value: string, timeoutMs: number) {
      await this.#page.locator(selector).pressSequentially(value, { timeout: timeoutMs })
    }
    async press(key: string, selector: string | undefined, timeoutMs: number) {
      if (selector === undefined) await this.#page.keyboard.press(key)
      else await this.#page.press(selector, key, { timeout: timeoutMs })
    }
    async select(selector: string, values: string[], timeoutMs: number) {
      await this.#page.selectOption(selector, values, { timeout: timeoutMs })
    }
    async waitFor(selector: string, timeoutMs: number) {
      await this.#page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs })
    }
    async text(timeoutMs: number) {
      // A page without a body (about:blank, a download) has no text.
      const body = await this.#page.locator('body').innerText({ timeout: timeoutMs }).catch(() => '')
      return text(body)
    }
    async html() {
      return text(await this.#page.content())
    }
    async evaluate(source: string, arg: unknown, world: 'isolated' | 'main') {
      return this.#page.evaluate(evaluateFunction(source), arg, { exposeFunctions: false }, world === 'isolated')
    }
    url() {
      return this.#page.url()
    }
    async title() {
      return this.#page.title()
    }
    async close() {
      tabs.delete(this.#page)
      await this.#page.close()
    }
  }

  const initial = context.pages()[0]
  let spare: Page | undefined = initial && initial.url() === 'about:blank' ? initial : undefined

  return {
    async open(): Promise<EngineTab> {
      let page = spare
      spare = undefined
      if (page === undefined) {
        page = await context.newPage()
        watch(page)
      }
      const tab = new PatchrightTab(page)
      tabs.set(page, tab)
      return tab
    },
    async close() {
      closing = true
      await context.close().catch(() => {})
      display?.stop()
    },
  }
}
