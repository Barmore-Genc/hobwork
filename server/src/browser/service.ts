import { randomBytes } from 'node:crypto'
import type { BrowserRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import { BROWSER_DEFAULT_TIMEOUT_MS, BROWSER_MAX_TIMEOUT_MS, BrowserError } from '../../../packages/sdk/src/webbrowser.ts'
import { hostMatches } from '../sandbox/egress.ts'
import { navigationProblem, parseBrowserSites } from './allowlist.ts'
import { browserExecutable, patchrightEngine, type Engine, type EngineFactory, type EngineTab } from './engine.ts'
import type { BrowserSettings } from './settings.ts'

// A hob and, for a preview, its branch. Tabs belong to one of these, so two
// hobs never see each other's tabs even though they share the profile.
export type BrowserSession = { project: string; branch?: string }

// A secret the call may type into a form, with the hosts people bound it to.
export type BrowserSecret = { value: string; hosts: string[] }

export type BrowserCall = {
  session: BrowserSession
  // `browser.sites` from the committed hobwork.json.
  sites: string[]
  // Secrets assigned to the hob, by the environment name the guest knows.
  secrets?: Record<string, BrowserSecret>
  request: BrowserRequest
}

type Tab = {
  id: string
  session: BrowserSession
  sites: ReturnType<typeof parseBrowserSites>
  engine: EngineTab
  // Selectors a secret was typed into, covered in screenshots because pixels
  // cannot be scrubbed like text.
  masked: Set<string>
  // Commands for one tab run in order, so two invocations do not interleave.
  chain: Promise<unknown>
  queued: number
}

export type BrowserTabView = { id: string; branch?: string; url: string; title: string }

export type BrowserService = {
  run(call: BrowserCall): Promise<unknown>
  status(): { running: boolean; tabs: number; startedAt?: string }
  // Tabs of a hob, for the page that shows them to the person who runs the host.
  tabsOf(project: string): Promise<BrowserTabView[]>
  // A JPEG of one tab as it is now, base64, for that page.
  screenshotOf(tabId: string): Promise<string | undefined>
  close(): Promise<void>
}

// Waiting commands for one tab before a call answers busy.
const MAX_QUEUE = 4
const IDLE_CHECK_MS = 15_000
const ERROR_CHARS = 400

const SELECTOR_ACTIONS = new Set(['click', 'hover', 'fill', 'type', 'select', 'waitFor', 'press'])
// Base64 JPEG a screenshot may be, which is about 1.5 MB of image. The
// endpoint's own result limit sits just above it.
const MAX_SCREENSHOT_CHARS = 2_000_000

function short(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim()
  return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS)}…` : text
}

function sessionOf(session: BrowserSession): string {
  return session.branch === undefined ? session.project : `${session.project}/${session.branch}`
}

export function createBrowserService(options: {
  settings: BrowserSettings
  // Tests swap the browser for a fake; the host uses patchright.
  engine?: EngineFactory
  log?: (level: 'info' | 'warn', message: string) => void
  // Tabs came or went, or the browser started or stopped.
  onChange?: (project: string) => void
}): BrowserService {
  const { settings } = options
  const createEngine = options.engine ?? patchrightEngine
  const log = options.log ?? (() => {})
  const changed = options.onChange ?? (() => {})

  let engine: Engine | undefined
  let starting: Promise<Engine> | undefined
  let startingAt: string | undefined
  let lastUsed = Date.now()
  const tabs = new Map<string, Tab>()
  const byEngineTab = new Map<EngineTab, Tab>()

  function forget(): void {
    tabs.clear()
    byEngineTab.clear()
  }

  async function stop(reason: string): Promise<void> {
    const current = engine
    if (!current) return
    const projects = new Set([...tabs.values()].map((tab) => tab.session.project))
    engine = undefined
    starting = undefined
    startingAt = undefined
    forget()
    for (const project of projects) changed(project)
    if (reason !== 'host is stopping') log('info', `Browser: stopped (${reason})`)
    await current.close().catch(() => {})
  }

  async function start(): Promise<Engine> {
    if (engine) return engine
    if (starting) return starting
    // A host without a browser says so instead of failing somewhere inside
    // Playwright. Tests pass their own engine and skip the check.
    if (options.engine === undefined && (await browserExecutable(settings)) === undefined) {
      throw new BrowserError(
        'not_configured',
        'This Hobwork host has no browser installed. Whoever runs Hobwork can install one with: pnpm -C server browser:install',
      )
    }
    starting = createEngine({
      settings,
      // A tab navigates only inside the sites its hob declared. The tab is
      // looked up here rather than captured, so a new commit's wider list
      // applies to tabs that are already open.
      navigationProblem: (url, tab) => {
        const owned = byEngineTab.get(tab)
        return owned ? navigationProblem(url, owned.sites) : 'This page does not belong to a hob'
      },
      onBlocked: (url, reason) => log('warn', `Browser: blocked ${url}. ${reason}`),
      onClosed: (reason) => {
        if (!engine) return
        const projects = new Set([...tabs.values()].map((tab) => tab.session.project))
        engine = undefined
        starting = undefined
        startingAt = undefined
        forget()
        for (const project of projects) changed(project)
        log('warn', `Browser: ${reason}. It starts again with the next call`)
      },
      log,
    })
      .then((started) => {
        engine = started
        starting = undefined
        startingAt = new Date().toISOString()
        log('info', `Browser: started ${settings.headless ? 'headless' : 'with a display'}`)
        return started
      })
      .catch((err: unknown) => {
        starting = undefined
        const message = err instanceof Error ? err.message : String(err)
        throw new BrowserError('not_configured', `This Hobwork host could not start its browser: ${short(message)}`)
      })
    return starting
  }

  function ownedBy(tab: Tab, session: BrowserSession): boolean {
    return tab.session.project === session.project && tab.session.branch === session.branch
  }

  // A placeholder in typed text becomes the value only for the hosts people
  // bound the secret to, like ctx.fetch does it for headers.
  function substitute(
    tab: Tab,
    value: string,
    placeholders: Record<string, string> | undefined,
    secrets: Record<string, BrowserSecret> | undefined,
  ): { text: string; secret: boolean } {
    let out = value
    let substituted = false
    let hostname: string
    try {
      hostname = new URL(tab.engine.url()).hostname
    } catch {
      hostname = ''
    }
    for (const [name, placeholder] of Object.entries(placeholders ?? {})) {
      if (!out.includes(placeholder)) continue
      const secret = secrets?.[name]
      if (!secret || !hostname || !hostMatches(hostname, secret.hosts)) {
        throw new BrowserError(
          'not_allowed',
          `Hobwork does not send ${name} to ${hostname || 'this page'}. Secrets go only to the hosts people bound them to, and this hob gets only the secrets assigned to it`,
        )
      }
      out = out.split(placeholder).join(secret.value)
      substituted = true
    }
    return { text: out, secret: substituted }
  }

  async function execute(tab: Tab, request: BrowserRequest, secrets: Record<string, BrowserSecret> | undefined): Promise<unknown> {
    const timeoutMs = Math.min(request.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS, BROWSER_MAX_TIMEOUT_MS)
    const page = tab.engine
    try {
      switch (request.action) {
        case 'close':
          tabs.delete(tab.id)
          byEngineTab.delete(tab.engine)
          await page.close()
          changed(tab.session.project)
          return null
        case 'goto':
          return await page.goto(request.url, timeoutMs).then(() => null)
        case 'back':
          return await page.back(timeoutMs).then(() => null)
        case 'reload':
          return await page.reload(timeoutMs).then(() => null)
        case 'click':
          return await page.click(request.selector, timeoutMs).then(() => null)
        case 'hover':
          return await page.hover(request.selector, timeoutMs).then(() => null)
        case 'fill':
        case 'type': {
          const given = substitute(tab, request.text, request.secrets, secrets)
          if (given.secret) tab.masked.add(request.selector)
          const work = request.action === 'fill' ? page.fill.bind(page) : page.type.bind(page)
          return await work(request.selector, given.text, timeoutMs).then(() => null)
        }
        case 'press': {
          const given = substitute(tab, request.key, request.secrets, secrets)
          if (given.secret && request.selector !== undefined) tab.masked.add(request.selector)
          return await page.press(given.text, request.selector, timeoutMs).then(() => null)
        }
        case 'select':
          return await page.select(request.selector, request.values, timeoutMs).then(() => null)
        case 'waitFor':
          return await page.waitFor(request.selector, timeoutMs).then(() => null)
        case 'text':
          return await page.text(timeoutMs)
        case 'html':
          return await page.html()
        case 'evaluate':
          return await page.evaluate(request.source, request.arg, request.world ?? 'isolated')
        case 'url':
          return page.url()
        case 'title':
          return await page.title()
        case 'screenshot': {
          const data = await page.screenshot({ fullPage: request.fullPage === true, mask: [...tab.masked], timeoutMs })
          if (data.length > MAX_SCREENSHOT_CHARS) {
            throw new BrowserError(
              'bad_request',
              `The screenshot is ${Math.round(data.length / 1024)} KB, more than a browser call may return. Take it of the window rather than the whole page`,
            )
          }
          return data
        }
        default:
          throw new BrowserError('bad_request', `${request.action} does not act on a tab`)
      }
    } catch (err) {
      throw browserError(err, request.action, timeoutMs)
    }
  }

  function browserError(err: unknown, action: string, timeoutMs: number): BrowserError {
    if (err instanceof BrowserError) return err
    const message = err instanceof Error ? err.message : String(err)
    const name = (err as { name?: string } | null)?.name
    if (name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(message)) {
      const code = SELECTOR_ACTIONS.has(action) ? 'selector_timeout' : 'timeout'
      return new BrowserError(code, short(message))
    }
    if (/has been closed|Target closed|browser has been closed|Session closed/i.test(message)) {
      return new BrowserError('crashed', `The browser stopped while the command ran: ${short(message)}`)
    }
    if (/ERR_BLOCKED_BY_CLIENT/.test(message)) {
      return new BrowserError(
        'not_allowed',
        `The page went to a site this hob may not open. Add it to "browser.sites" in hobwork.json and commit. ${short(message)}`,
      )
    }
    if (/Execution context was destroyed|frame was detached|most likely because of a navigation/i.test(message)) {
      return new BrowserError('tab_gone', `The tab navigated away while the command ran: ${short(message)}`)
    }
    return new BrowserError('host_error', `${action} failed after at most ${timeoutMs}ms: ${short(message)}`)
  }

  async function open(call: BrowserCall): Promise<unknown> {
    const { request, session } = call
    if (request.action !== 'open') throw new BrowserError('bad_request', 'not an open')
    const url = new URL(request.url)
    const sites = parseBrowserSites(call.sites)
    const problem = navigationProblem(url, sites)
    if (problem !== undefined) throw new BrowserError('not_allowed', problem)
    const mine = [...tabs.values()].filter((tab) => ownedBy(tab, session))
    if (mine.length >= settings.maxTabsPerHob) {
      throw new BrowserError(
        'too_many_tabs',
        `${sessionOf(session)} already has ${mine.length} tabs open, the most a hob may have. Close one with ctx.browser.tabs() and tab.close()`,
      )
    }
    if (tabs.size >= settings.maxTabs) {
      throw new BrowserError('too_many_tabs', `The browser has ${tabs.size} tabs open, the most it may have`)
    }
    const timeoutMs = Math.min(request.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS, BROWSER_MAX_TIMEOUT_MS)
    const started = await start()
    const engineTab = await started.open().catch((err: unknown) => {
      throw browserError(err, 'open', timeoutMs)
    })
    const tab: Tab = {
      id: randomBytes(8).toString('hex'),
      session,
      sites,
      engine: engineTab,
      masked: new Set(),
      chain: Promise.resolve(),
      queued: 0,
    }
    // Known before the first navigation, so the allowlist covers it too.
    tabs.set(tab.id, tab)
    byEngineTab.set(engineTab, tab)
    await engineTab.goto(url.href, timeoutMs).catch((err: unknown) => {
      throw browserError(err, 'open', timeoutMs)
    })
    changed(session.project)
    return { id: tab.id, url: engineTab.url(), title: await engineTab.title().catch(() => '') }
  }

  async function runOnTab(call: BrowserCall): Promise<unknown> {
    const { request, session } = call
    const tab = tabs.get(request.tab ?? '')
    // A tab of another hob answers like one that is gone: whether it exists is
    // none of this hob's business.
    if (!tab || !ownedBy(tab, session)) {
      throw new BrowserError('tab_gone', `There is no open tab ${JSON.stringify(request.tab)}. ctx.browser.tabs() lists them`)
    }
    if (tab.queued >= MAX_QUEUE) {
      throw new BrowserError('busy', 'Too many commands are already waiting for this tab. Wait for them and try again')
    }
    // The sites of the latest call, so a commit that widens them applies.
    tab.sites = parseBrowserSites(call.sites)
    const timeoutMs = Math.min(request.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS, BROWSER_MAX_TIMEOUT_MS)
    tab.queued += 1
    const next = tab.chain.then(() => execute(tab, request, call.secrets))
    tab.chain = next.catch(() => {})
    try {
      return await withTimeout(next, timeoutMs, request.action)
    } finally {
      tab.queued -= 1
    }
  }

  // evaluate and title have no timeout of their own in Playwright, so every
  // command gets one here as well.
  function withTimeout<T>(work: Promise<T>, timeoutMs: number, action: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BrowserError('timeout', `${action} took longer than ${timeoutMs}ms`)), timeoutMs + 5_000)
      timer.unref()
      work.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err: unknown) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }

  const idle = setInterval(() => {
    if (!engine) return
    if (Date.now() - lastUsed < settings.idleTimeoutMs) return
    void stop(`no calls for ${Math.round(settings.idleTimeoutMs / 1000)} seconds`)
  }, IDLE_CHECK_MS)
  idle.unref()

  return {
    async run(call) {
      lastUsed = Date.now()
      if (!settings.enabled) {
        throw new BrowserError('not_configured', 'The browser is turned off on this Hobwork host (HOBWORK_BROWSER=off)')
      }
      if (call.request.action === 'open') return open(call)
      if (call.request.action === 'tabs') {
        const mine = [...tabs.values()].filter((tab) => ownedBy(tab, call.session))
        return Promise.all(
          mine.map(async (tab) => ({ id: tab.id, url: tab.engine.url(), title: await tab.engine.title().catch(() => '') })),
        )
      }
      return runOnTab(call)
    },
    status() {
      return { running: engine !== undefined, tabs: tabs.size, ...(startingAt === undefined ? {} : { startedAt: startingAt }) }
    },
    async tabsOf(project) {
      const mine = [...tabs.values()].filter((tab) => tab.session.project === project)
      return Promise.all(
        mine.map(async (tab) => ({
          id: tab.id,
          ...(tab.session.branch === undefined ? {} : { branch: tab.session.branch }),
          url: tab.engine.url(),
          title: await tab.engine.title().catch(() => ''),
        })),
      )
    },
    async screenshotOf(tabId) {
      const tab = tabs.get(tabId)
      // The person who runs the host sees it as it is, without the blocks a
      // handler's screenshot has.
      if (!tab) return undefined
      return tab.engine.screenshot({ fullPage: false, mask: [], timeoutMs: 15_000 }).catch(() => undefined)
    },
    async close() {
      clearInterval(idle)
      await stop('host is stopping')
    },
  }
}
