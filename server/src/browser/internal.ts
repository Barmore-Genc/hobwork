import type { BrowserRequest, BrowserResponse } from '../../../packages/sdk/src/runner/protocol.ts'
import { BrowserError } from '../../../packages/sdk/src/webbrowser.ts'
import { BrowserBadRequest, parseBrowserRequest } from './commands.ts'
import { redact } from './redact.ts'
import type { BrowserSecret, BrowserService } from './service.ts'

// Deployed handlers browse the sites hobwork.json declares. A branch preview
// needs the same list and someone's permission for that branch; anything else
// is refused here, before a page opens.
export type BrowserAccess = 'full' | { branch: string; allowed: () => boolean }

export type BrowserCallLog = {
  invocation?: number
  level: 'debug' | 'info' | 'warn'
  message: string
}

export type BrowserEndpointOptions = {
  project: string
  browser?: BrowserService
  access: BrowserAccess
  // `browser.sites` from the committed hobwork.json.
  sites: () => string[]
  // Secrets assigned to the hob, by environment name: what may be typed into a
  // form, and what is taken back out of everything the host returns.
  secrets?: () => Record<string, BrowserSecret>
  log?: (entry: BrowserCallLog) => void
}

const STATUS_BY_CODE: Record<string, number> = {
  not_configured: 503,
  not_allowed: 403,
  not_approved: 403,
  too_many_tabs: 429,
  busy: 429,
  timeout: 504,
  selector_timeout: 504,
  tab_gone: 410,
  crashed: 503,
  bad_request: 400,
}

// Reads: what a handler needs to decide something. They are logged at debug so
// a hob's log is not drowned by scraping.
const READ_ACTIONS = new Set(['tabs', 'text', 'html', 'url', 'title', 'evaluate', 'screenshot'])

const MAX_LOGGED_CHARS = 200
const MAX_RESULT_CHARS = 2 * 1024 * 1024

function short(text: string): string {
  return text.length > MAX_LOGGED_CHARS ? `${text.slice(0, MAX_LOGGED_CHARS)}…` : text
}

function describe(request: BrowserRequest): string {
  switch (request.action) {
    case 'open':
    case 'goto':
      return `${request.action} ${short(request.url)}`
    case 'close':
    case 'back':
    case 'reload':
    case 'tabs':
    case 'text':
    case 'html':
    case 'url':
    case 'title':
    case 'screenshot':
      return request.action
    case 'click':
    case 'hover':
    case 'waitFor':
      return `${request.action} ${short(request.selector)}`
    case 'fill':
    case 'type':
      // Never the text, which may hold a secret.
      return `${request.action} ${short(request.selector)}`
    case 'press':
      return `press in ${request.selector === undefined ? 'the focused element' : short(request.selector)}`
    case 'select':
      return `select ${short(request.selector)}`
    case 'evaluate':
      return `evaluate ${request.source.length} characters`
  }
}

function answer(response: BrowserResponse, status = 200): Response {
  return Response.json(response, { status })
}

function failure(code: string, message: string): Response {
  return answer({ ok: false, error: { code, message } }, STATUS_BY_CODE[code] ?? 502)
}

export async function browserResponse(body: string, options: BrowserEndpointOptions): Promise<Response> {
  let request: BrowserRequest
  try {
    request = parseBrowserRequest(body)
  } catch (err) {
    if (err instanceof BrowserBadRequest) return failure('bad_request', err.message)
    throw err
  }
  const invocation = request.invocation
  const log = (level: BrowserCallLog['level'], message: string) => options.log?.({ invocation, level, message })

  if (typeof options.access === 'object' && !options.access.allowed()) {
    log(
      'warn',
      `Browser: denied ${describe(request)}. Branch "${options.access.branch}" may not browse the web. Turn it on with the set_branch_browser MCP tool, or ask the user to turn on "Let this branch browse the web" for it on the hob page in Hobwork`,
    )
    return failure(
      'not_approved',
      `Branch "${options.access.branch}" may not browse the web. Turn it on with the set_branch_browser MCP tool, or ask the user to turn on "Let this branch browse the web" for it on the hob page in Hobwork`,
    )
  }
  const browser = options.browser
  if (!browser) {
    return failure(
      'not_configured',
      'This Hobwork host has no browser. Whoever runs Hobwork can install one with: pnpm -C server browser:install',
    )
  }

  const secrets = options.secrets?.() ?? {}
  // A URL can carry a token, so log lines are scrubbed like results.
  const scrub = (text: string) => String(redact(text, secrets))
  try {
    const result = await browser.run({
      session: typeof options.access === 'object' ? { project: options.project, branch: options.access.branch } : { project: options.project },
      sites: options.sites(),
      secrets,
      request,
    })
    const size = JSON.stringify(result)?.length ?? 0
    if (size > MAX_RESULT_CHARS) {
      throw new BrowserError(
        'bad_request',
        `The command returned ${Math.round(size / 1024)} KB, more than the ${Math.round(MAX_RESULT_CHARS / 1024)} KB a browser call may return. Ask the page for less`,
      )
    }
    log(READ_ACTIONS.has(request.action) ? 'debug' : 'info', `Browser: ${scrub(describe(request))}`)
    // A JPEG is bytes: a value that happened to appear in the base64 would
    // corrupt it, and the pixels a secret could be in are masked by the
    // service instead.
    const answerable = request.action === 'screenshot' ? result : redact(result, secrets)
    return answer({ ok: true, result: answerable })
  } catch (err) {
    const code = err instanceof BrowserError ? err.code : 'host_error'
    const message = err instanceof Error ? err.message : String(err)
    log(code === 'not_allowed' || code === 'not_approved' ? 'warn' : 'debug', `Browser: ${scrub(describe(request))} failed (${code}): ${scrub(short(message))}`)
    return failure(code, message)
  }
}
