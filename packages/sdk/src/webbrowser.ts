// Drives the browser the Hobwork host runs. A hob opens tabs, fills forms,
// clicks and reads pages that need JavaScript, without the browser living in
// the hob's VM. Only the sites `browser.sites` in hobwork.json declares are
// reachable, and everything the host returns passes through the secrets
// redaction filter.

// Tabs outlive the invocation that opened them, so a route call can carry on
// where a cron stopped.
export type BrowserTabInfo = { id: string; url: string; title: string }

export const BROWSER_DEFAULT_TIMEOUT_MS = 30_000
export const BROWSER_MAX_TIMEOUT_MS = 120_000
// Returned page text and HTML are cut here, like command output.
export const BROWSER_MAX_TEXT_CHARS = 100_000

export type BrowserErrorCode =
  // No browser is installed on the host, or whoever runs it turned it off.
  | 'not_configured'
  // The site is not in `browser.sites`.
  | 'not_allowed'
  // A branch preview without permission to browse.
  | 'not_approved'
  | 'too_many_tabs'
  // Too many commands were waiting for that tab.
  | 'busy'
  // The command took longer than its timeout.
  | 'timeout'
  // The selector did not appear or the element did not become actionable.
  | 'selector_timeout'
  // The tab was closed, or the browser stopped while it was open.
  | 'tab_gone'
  | 'crashed'
  | 'bad_request'
  // The host could not answer at all.
  | 'host_error'

// The runner and the handler bundle each have a copy of this class, so
// instanceof checks a brand instead of the prototype chain.
const BRAND = Symbol.for('hobwork.BrowserError')

export class BrowserError extends Error {
  code: BrowserErrorCode

  constructor(code: BrowserErrorCode, message: string) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
    Object.defineProperty(this, BRAND, { value: true })
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
  }
}

export type BrowserOptions = {
  // How long the host waits for the command, at most BROWSER_MAX_TIMEOUT_MS.
  timeoutMs?: number
}

export type BrowserEvaluateOptions = BrowserOptions & {
  // Where the function runs. The page's own world ("main") reads globals a page
  // set, like window.__DATA__; the isolated one cannot, and is what keeps the
  // browser from leaking the CDP Runtime domain to a detector. Default:
  // "isolated".
  world?: 'isolated' | 'main'
}

export type BrowserPressOptions = BrowserOptions & {
  // Focus this element first, else keys go to whatever has focus.
  selector?: string
}

// One page in the host's browser. Selectors are Playwright's, so "css=#id",
// "text=Sign in" and "role=button[name=Save]" all work.
export interface BrowserTab {
  readonly id: string
  goto(url: string, options?: BrowserOptions): Promise<void>
  back(options?: BrowserOptions): Promise<void>
  reload(options?: BrowserOptions): Promise<void>
  click(selector: string, options?: BrowserOptions): Promise<void>
  hover(selector: string, options?: BrowserOptions): Promise<void>
  // Types the text into the element, replacing what was there. A secret
  // placeholder is swapped for the real value by the host, when the tab's site
  // is one of the secret's hosts.
  fill(selector: string, text: string, options?: BrowserOptions): Promise<void>
  // Like fill, but sends the keys one at a time, for fields that need it.
  type(selector: string, text: string, options?: BrowserOptions): Promise<void>
  press(key: string, options?: BrowserPressOptions): Promise<void>
  // Selects options of a <select> by their values.
  select(selector: string, values: string[], options?: BrowserOptions): Promise<void>
  // Waits for the element to be attached and visible.
  waitFor(selector: string, options?: BrowserOptions): Promise<void>
  // The page's visible text (document.body.innerText), cut at
  // BROWSER_MAX_TEXT_CHARS.
  text(options?: BrowserOptions): Promise<string>
  // The page's HTML, cut at BROWSER_MAX_TEXT_CHARS.
  html(options?: BrowserOptions): Promise<string>
  // Runs a function in the page and returns its JSON result. Pass a function or
  // its source as a string; it receives `arg`.
  evaluate<T = unknown, A = unknown>(
    fn: ((arg: A) => T | Promise<T>) | string,
    arg?: A,
    options?: BrowserEvaluateOptions,
  ): Promise<T>
  url(): Promise<string>
  title(): Promise<string>
  // Closes this tab. Other tabs of the hob stay open.
  close(): Promise<void>
}

// The host's browser, shared by every hob: tabs share a profile, so cookies a
// hob established are visible to any hob that declares the same site. A tab is
// only reachable by the hob that opened it, and no hob can close the browser.
export interface Browser {
  // Opens a new tab, or reuses one that is already on that site.
  open(url: string, options?: BrowserOptions): Promise<BrowserTab>
  // The tabs of this hob, open right now.
  tabs(): Promise<BrowserTabInfo[]>
  // A tab of this hob by its ID.
  tab(id: string): Promise<BrowserTab>
}
