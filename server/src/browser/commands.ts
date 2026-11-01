import {
  BROWSER_DEFAULT_TIMEOUT_MS,
  BROWSER_MAX_TEXT_CHARS,
  BROWSER_MAX_TIMEOUT_MS,
} from '../../../packages/sdk/src/webbrowser.ts'
import type { BrowserRequest } from '../../../packages/sdk/src/runner/protocol.ts'

// Hob code is untrusted, so every field is bounded here before the host hands
// it to Playwright.
export class BrowserBadRequest extends Error {}

const ACTIONS = new Set([
  'open',
  'tabs',
  'close',
  'goto',
  'back',
  'reload',
  'click',
  'hover',
  'fill',
  'type',
  'press',
  'select',
  'waitFor',
  'text',
  'html',
  'evaluate',
  'url',
  'title',
])

const MAX_URL_CHARS = 4096
const MAX_SELECTOR_CHARS = 1024
const MAX_VALUE_CHARS = 1024
const MAX_KEY_CHARS = 64
const MAX_VALUES = 100
const MAX_SOURCE_CHARS = 100_000
const MAX_SECRETS = 64
const MAX_SECRET_PLACEHOLDER_CHARS = 1024
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
const TAB_ID = /^[a-f0-9]{16}$/

function fail(message: string): never {
  throw new BrowserBadRequest(message)
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Body must be a JSON object')
  return value as Record<string, unknown>
}

function text(value: unknown, what: string, max: number, { allowEmpty = false } = {}): string {
  if (typeof value !== 'string') fail(`${what} must be a string`)
  if (!allowEmpty && value === '') fail(`${what} must not be empty`)
  if (value.length > max) fail(`${what} is at most ${max} characters`)
  return value
}

function timeout(value: unknown): number {
  if (value === undefined || value === null) return BROWSER_DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > BROWSER_MAX_TIMEOUT_MS) {
    fail(`timeoutMs must be a whole number of milliseconds from 1 to ${BROWSER_MAX_TIMEOUT_MS}`)
  }
  return value
}

function url(value: unknown): string {
  const raw = text(value, 'url', MAX_URL_CHARS)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    fail(`${JSON.stringify(raw)} is not a URL`)
  }
  if (parsed.username || parsed.password) fail('A tab URL cannot carry a user name or password')
  return parsed.href
}

function values(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail('values must be a non-empty list of option values')
  if (value.length > MAX_VALUES) fail(`values has at most ${MAX_VALUES} entries`)
  return value.map((entry) => text(entry, 'each value', MAX_VALUE_CHARS))
}

function placeholders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  const entries = Object.entries(object(value))
  if (entries.length > MAX_SECRETS) fail(`secrets has at most ${MAX_SECRETS} entries`)
  return Object.fromEntries(
    entries.map(([name, placeholder]) => {
      if (!ENV_NAME.test(name)) fail(`${JSON.stringify(name)} is not an environment name`)
      return [name, text(placeholder, 'each secret placeholder', MAX_SECRET_PLACEHOLDER_CHARS)]
    }),
  )
}

// `text` for evaluate may be empty, and its source is sized like a selector.
export function parseBrowserRequest(body: string): BrowserRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    fail('Body must be JSON')
  }
  const request = object(parsed)
  const action = text(request.action, 'action', 32)
  if (!ACTIONS.has(action)) fail(`${JSON.stringify(action)} is not a browser action`)
  if (typeof request.invocation !== 'number' && request.invocation !== undefined) fail('invocation must be a number')

  const wantsTab = action !== 'open' && action !== 'tabs'
  if (wantsTab) {
    if (typeof request.tab !== 'string' || !TAB_ID.test(request.tab)) fail('tab must be the ID of a tab of this hob')
  } else if (request.tab !== undefined) {
    fail(`${action} does not act on a tab`)
  }

  const common = {
    action,
    ...(wantsTab ? { tab: request.tab as string } : {}),
    ...(typeof request.invocation === 'number' ? { invocation: request.invocation } : {}),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: timeout(request.timeoutMs) }),
  }

  switch (action) {
    case 'open':
    case 'goto':
      return { ...common, action, url: url(request.url) } as BrowserRequest
    case 'back':
    case 'reload':
    case 'tabs':
    case 'text':
    case 'html':
    case 'url':
    case 'title':
    case 'close':
      return common as BrowserRequest
    case 'click':
    case 'hover':
    case 'waitFor':
      return { ...common, action, selector: text(request.selector, 'selector', MAX_SELECTOR_CHARS) } as BrowserRequest
    case 'fill':
    case 'type':
      return {
        ...common,
        action,
        selector: text(request.selector, 'selector', MAX_SELECTOR_CHARS),
        text: text(request.text, 'text', BROWSER_MAX_TEXT_CHARS, { allowEmpty: true }),
        secrets: placeholders(request.secrets),
      } as BrowserRequest
    case 'press':
      return {
        ...common,
        action,
        key: text(request.key, 'key', MAX_KEY_CHARS),
        ...(request.selector === undefined ? {} : { selector: text(request.selector, 'selector', MAX_SELECTOR_CHARS) }),
        secrets: placeholders(request.secrets),
      } as BrowserRequest
    case 'select':
      return {
        ...common,
        action,
        selector: text(request.selector, 'selector', MAX_SELECTOR_CHARS),
        values: values(request.values),
      } as BrowserRequest
    case 'evaluate': {
      const world = request.world === undefined ? 'isolated' : request.world
      if (world !== 'isolated' && world !== 'main') fail('world must be "isolated" or "main"')
      return {
        ...common,
        action,
        source: text(request.source, 'source', MAX_SOURCE_CHARS),
        ...(request.arg === undefined ? {} : { arg: request.arg }),
        world,
      } as BrowserRequest
    }
    default:
      return fail(`${JSON.stringify(action)} is not a browser action`)
  }
}

// The source of an evaluate call as a function the page runs. The guest sends
// a function's own text, so it is wrapped rather than evaluated here.
export function evaluateFunction(source: string): (arg: unknown) => unknown {
  return new Function('arg', `return (${source})(arg)`) as (arg: unknown) => unknown
}
