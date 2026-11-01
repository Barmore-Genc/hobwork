import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { browserExecutable, patchrightEngine, type Engine, type EngineOptions } from './engine.ts'
import { loadBrowserSettings } from './settings.ts'

// Boots a real Chromium, so it only runs when asked: HOBWORK_BROWSER_TESTS=1
// pnpm -C server test. The browser has to be installed first with
// pnpm -C server browser:install, and the test serves its own http pages,
// which the hob rules would refuse (https only, no loopback); the engine is
// given a navigation rule of its own instead.
const enabled = process.env.HOBWORK_BROWSER_TESTS === '1'

const PAGE = `<!doctype html>
<html><head><title>A shop</title></head>
<body>
  <h1 id="title">Spools</h1>
  <form><input id="search" name="q"><button id="go" type="button">Search</button></form>
  <p id="result"></p>
  <script>
    window.__state = { filament: 'PLA' }
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('result').textContent = 'found ' + document.getElementById('search').value
    })
  </script>
</body></html>`

class PageServer {
  server: Server | undefined
  base = ''

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.url === '/blocked') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Should never load</h1>')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const { port } = this.server!.address() as AddressInfo
    this.base = `http://127.0.0.1:${port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

let dataDir = ''

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hobwork-browser-test-'))
  // The profile is the test's own, the browser is the one browser:install put
  // in the repository's data dir.
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(import.meta.dirname, '../../../data/browser/browsers')
  // The installed extension comes along, so the test exercises the flags the
  // host uses.
  const installed = join(import.meta.dirname, '../../../data/browser/extensions')
  if (existsSync(installed)) {
    mkdirSync(join(dataDir, 'browser'), { recursive: true })
    cpSync(installed, join(dataDir, 'browser/extensions'), { recursive: true })
  }
})

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe.skipIf(!enabled)('the real browser', () => {
  test('opens pages, fills forms, clicks, reads text and code, and refuses blocked navigations', async () => {
    const settings = loadBrowserSettings(dataDir, { HOBWORK_BROWSER_HEADLESS: '1' })
    expect(await browserExecutable(settings)).toBeDefined()

    const pages = new PageServer()
    await pages.start()
    const blocked: string[] = []
    const logs: string[] = []
    let closed = 0
    const options: EngineOptions = {
      settings,
      navigationProblem: (url) => (url.pathname.startsWith('/blocked') ? 'The test blocks this page' : undefined),
      onBlocked: (url) => blocked.push(url),
      onClosed: () => {
        closed += 1
      },
      log: (level, message) => logs.push(`${level} ${message}`),
    }
    const engine: Engine = await patchrightEngine(options)
    try {
      const tab = await engine.open()
      await tab.goto(`${pages.base}/`, 15_000)
      expect(tab.url()).toBe(`${pages.base}/`)
      expect(await tab.title()).toBe('A shop')
      // Chromium shows its own error page in place of the blocked document.
      expect(await tab.text(15_000)).not.toContain('Should never load')

      await tab.fill('#search', 'PETG', 15_000)
      await tab.click('#go', 15_000)
      await tab.waitFor('#result', 15_000)
      expect(await tab.text(15_000)).toContain('found PETG')

      // The page's own world has its globals; the isolated one only sees the DOM.
      await expect(tab.evaluate('() => window.__state.filament', undefined, 'main')).resolves.toBe('PLA')
      await expect(tab.evaluate('() => window.__state', undefined, 'isolated')).resolves.toBeUndefined()
      await expect(tab.evaluate('(tag) => document.querySelector(tag).textContent', 'h1', 'isolated')).resolves.toBe('Spools')
      expect(await tab.html()).toContain('<h1 id="title">Spools</h1>')

      // A navigation the rules refuse never lands, and the host hears about it.
      await expect(tab.goto(`${pages.base}/blocked`, 15_000)).rejects.toThrow()
      expect(blocked).toEqual([`${pages.base}/blocked`])
      // Chromium shows its own error page in place of the blocked document.
      expect(await tab.text(15_000)).not.toContain('Should never load')
      expect(logs).toContainEqual(expect.stringContaining('uBlock Origin Lite is loaded'))
      // Headless always says HeadlessChrome, which is why the host warns about
      // it; what patchright fixes is the automation flag.
      expect(logs).toContainEqual(expect.stringContaining('running headless'))
      expect(await tab.evaluate('() => navigator.userAgent', undefined, 'isolated')).toContain('HeadlessChrome')
      expect(await tab.evaluate('() => navigator.webdriver', undefined, 'isolated')).toBe(false)
      expect(closed).toBe(0)
      await tab.close()
    } finally {
      await engine.close()
      await pages.stop()
    }
  }, 120_000)

  test('the profile is kept between runs', async () => {
    const settings = loadBrowserSettings(dataDir, { HOBWORK_BROWSER_HEADLESS: '1' })
    const options = (): EngineOptions => ({
      settings,
      navigationProblem: () => undefined,
      onBlocked: () => {},
      onClosed: () => {},
      log: () => {},
    })
    const pages = new PageServer()
    await pages.start()
    try {
      const first = await patchrightEngine(options())
      const tab = await first.open()
      await tab.goto(pages.base, 15_000)
      await tab.evaluate('() => { document.cookie = "kept=yes; max-age=86400; path=/" }', undefined, 'main')
      await first.close()

      const second = await patchrightEngine(options())
      const again = await second.open()
      await again.goto(pages.base, 15_000)
      expect(await again.evaluate('() => document.cookie', undefined, 'main')).toContain('kept=yes')
      await second.close()
    } finally {
      await pages.stop()
    }
  }, 120_000)
})
