// The protocol between hob UIs and the Hobwork app. The app's web view defines
// `window.hobworkNative` on hob origins only; everywhere else (a browser, the
// web UI in a browser) it is missing and every call rejects with "unavailable".

export type NativeErrorCode = 'unavailable' | 'denied' | 'cancelled' | 'failed'

const CODES: readonly string[] = ['unavailable', 'denied', 'cancelled', 'failed']

export class NativeError extends Error {
  // unavailable: not in the Hobwork app, not on this platform or app version,
  //   or not set up on this device.
  // denied: the person said no, in the app's question or in Settings.
  // cancelled: the person closed the sheet or dialog.
  // failed: anything else, including bad arguments.
  code: NativeErrorCode
  constructor(code: NativeErrorCode, message: string) {
    super(message)
    this.name = 'NativeError'
    this.code = code
  }
}

export type NativeReply = { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string } }

export type NativePlatform = 'ios' | 'macos'

// `window.hobworkNative`, as the app's user script defines it.
export interface NativeBridge {
  version: number
  platform: NativePlatform
  // Capability name to its methods, e.g. { haptics: ['error', 'impact', ...] }.
  capabilities: Readonly<Record<string, readonly string[]>>
  call(capability: string, method: string, args?: unknown): Promise<NativeReply>
  // Returns a function that stops listening.
  listen(event: string, listener: (data: unknown) => void): () => void
}

declare global {
  var hobworkNative: NativeBridge | undefined
}

function bridge(): NativeBridge | undefined {
  const value = globalThis.hobworkNative
  return value && typeof value.call === 'function' ? value : undefined
}

// True inside the Hobwork app on a hob's own origin.
export function available(): boolean {
  return bridge() !== undefined
}

export function platform(): NativePlatform | undefined {
  return bridge()?.platform
}

// Whether this app has a capability, or one of its methods:
// has('haptics'), has('print', 'pickPrinter').
export function has(capability: string, method?: string): boolean {
  const methods = bridge()?.capabilities[capability]
  if (!methods) return false
  return method === undefined || methods.includes(method)
}

// Calls a method and returns its value. Rejects with a NativeError.
export async function call<T = unknown>(capability: string, method: string, args?: unknown): Promise<T> {
  const native = bridge()
  if (!native) throw new NativeError('unavailable', 'Native features are only available in the Hobwork app')
  if (!has(capability, method)) throw new NativeError('unavailable', `This app has no ${capability}.${method}`)
  let reply: NativeReply
  try {
    reply = await native.call(capability, method, args ?? null)
  } catch (err) {
    throw new NativeError('failed', err instanceof Error ? err.message : String(err))
  }
  if (!reply || typeof reply !== 'object') throw new NativeError('failed', `${capability}.${method} answered nothing`)
  if (reply.ok) return reply.value as T
  const code = CODES.includes(reply.error?.code) ? (reply.error.code as NativeErrorCode) : 'failed'
  throw new NativeError(code, reply.error?.message ?? `${capability}.${method} failed`)
}

// Listens for an event the app sends, named `<capability>.<event>`, e.g.
// on('nfc.scan', (scan) => ...). Returns a function that stops listening.
// Outside the app nothing is ever sent.
export function on<T = unknown>(event: string, listener: (data: T) => void): () => void {
  const native = bridge()
  if (!native) return () => {}
  return native.listen(event, listener as (data: unknown) => void)
}

// Bytes for calls that take a file, as base64. A string is a URL on the hob's
// own origin, fetched with the page's session.
export type NativeData = Blob | ArrayBuffer | ArrayBufferView | string

export async function encodeData(data: NativeData): Promise<string> {
  let bytes: Uint8Array
  if (typeof data === 'string') {
    const page = (globalThis as { location?: { href: string; origin: string } }).location
    const url = new URL(data, page?.href)
    if (page && url.origin !== page.origin) {
      throw new NativeError('failed', 'Only files on this hob can be sent to the app')
    }
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new NativeError('failed', `${url.pathname} answered ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
  } else if (data instanceof Blob) {
    bytes = new Uint8Array(await data.arrayBuffer())
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data)
  } else {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
