import type { Browser, BrowserErrorCode, BrowserOptions, BrowserTab, BrowserTabInfo } from '../webbrowser.ts'
import { internalPost } from './internal-fetch.ts'
import { BROWSER_MAX_TIMEOUT_MS, type BrowserRequest, type BrowserResponse } from './protocol.ts'

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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type BrowserSend = (request: DistributiveOmit<BrowserRequest, 'invocation'>) => Promise<BrowserResponse>

// What the client sends: everything but the fields it fills in itself.
type ClientCall = DistributiveOmit<BrowserRequest, 'invocation' | 'secrets' | 'timeoutMs'>

function timeout(options: BrowserOptions | undefined): number | undefined {
  const ms = options?.timeoutMs
  if (ms === undefined) return undefined
  if (!Number.isInteger(ms) || ms < 1 || ms > BROWSER_MAX_TIMEOUT_MS) {
    throw new BrowserError('bad_request', `timeoutMs must be a whole number of milliseconds from 1 to ${BROWSER_MAX_TIMEOUT_MS}`)
  }
  return ms
}

function info(value: unknown): BrowserTabInfo {
  const tab = value as BrowserTabInfo | undefined
  if (!tab || typeof tab.id !== 'string') throw new BrowserError('host_error', 'The host answered without a tab')
  return tab
}

export function createBrowserClient(send: BrowserSend, secrets: Record<string, string> = {}): Browser {
  const placeholders = Object.freeze({ ...secrets })

  async function run<T>(request: ClientCall, options?: BrowserOptions): Promise<T> {
    const ms = timeout(options)
    const answer = await send({ ...request, ...(ms === undefined ? {} : { timeoutMs: ms }) })
    if (!answer.ok) throw new BrowserError(answer.error.code as BrowserError['code'], answer.error.message)
    return answer.result as T
  }

  // Typed text may carry the placeholder of a secret, which only the host can
  // turn into the value.
  async function withSecrets<T>(request: ClientCall, options?: BrowserOptions): Promise<T> {
    const ms = timeout(options)
    const answer = await send({
      ...request,
      ...(ms === undefined ? {} : { timeoutMs: ms }),
      ...(Object.keys(placeholders).length ? { secrets: placeholders } : {}),
    })
    if (!answer.ok) throw new BrowserError(answer.error.code as BrowserError['code'], answer.error.message)
    return answer.result as T
  }

  function tab(id: string): BrowserTab {
    const call = <T>(request: ClientCall, options?: BrowserOptions) => run<T>({ ...request, tab: id }, options)
    return {
      id,
      goto: (url, options) => call<void>({ action: 'goto', url }, options),
      back: (options) => call<void>({ action: 'back' }, options),
      reload: (options) => call<void>({ action: 'reload' }, options),
      click: (selector, options) => call<void>({ action: 'click', selector }, options),
      hover: (selector, options) => call<void>({ action: 'hover', selector }, options),
      fill: (selector, text, options) => withSecrets<void>({ action: 'fill', selector, text, tab: id }, options),
      type: (selector, text, options) => withSecrets<void>({ action: 'type', selector, text, tab: id }, options),
      press: async (key, options) => {
        const { selector, ...rest } = options ?? {}
        await withSecrets<void>({ action: 'press', key, ...(selector === undefined ? {} : { selector }), tab: id }, rest)
      },
      select: (selector, values, options) => call<void>({ action: 'select', selector, values }, options),
      waitFor: (selector, options) => call<void>({ action: 'waitFor', selector }, options),
      text: (options) => call<string>({ action: 'text' }, options),
      html: (options) => call<string>({ action: 'html' }, options),
      evaluate: <T, A>(fn: ((arg: A) => T | Promise<T>) | string, arg?: A, options?: { world?: 'isolated' | 'main'; timeoutMs?: number }) =>
        call<T>(
          {
            action: 'evaluate',
            source: typeof fn === 'function' ? fn.toString() : fn,
            ...(arg === undefined ? {} : { arg }),
            ...(options?.world === undefined ? {} : { world: options.world }),
          },
          options,
        ),
      url: () => call<string>({ action: 'url' }),
      title: () => call<string>({ action: 'title' }),
      close: () => call<void>({ action: 'close' }),
    }
  }

  return {
    async open(url, options) {
      const opened = await run<unknown>({ action: 'open', url }, options)
      return tab(info(opened).id)
    },
    async tabs() {
      const opened = await run<unknown>({ action: 'tabs' })
      return Array.isArray(opened) ? opened.map(info) : []
    },
    tab: async (id) => tab(id),
  }
}

export function httpBrowserSender(baseUrl: string, invocation?: () => number | undefined): BrowserSend {
  return async (request) => {
    const res = await internalPost(baseUrl, '/v1/browser', JSON.stringify({ ...request, invocation: invocation?.() }))
    const body = (await res.json().catch(() => undefined)) as BrowserResponse | { error?: string } | undefined
    if (body && 'ok' in body) return body
    throw new BrowserError('host_error', `The host could not answer the browser call: HTTP ${res.status}${body?.error ? ` ${body.error}` : ''}`)
  }
}
