import { NativeError, type NativeBridge, type NativePlatform } from './bridge.ts'

export type FakeHandler = (args: unknown) => unknown

export type FakeBridge = NativeBridge & {
  // Every call, in order.
  calls: { capability: string; method: string; args: unknown }[]
  // Sends an event to the page's listeners.
  emit(event: string, data?: unknown): void
  // Removes it from globalThis.
  uninstall(): void
}

// A stand-in for the app's bridge in tests of hob UIs, installed as
// globalThis.hobworkNative. Handlers are keyed by "capability.method"; one
// that throws a NativeError rejects with its code.
//
//   const bridge = createFakeBridge({ 'haptics.success': () => null })
//   ...
//   bridge.uninstall()
export function createFakeBridge(handlers: Record<string, FakeHandler>, platform: NativePlatform = 'ios'): FakeBridge {
  const capabilities: Record<string, string[]> = {}
  for (const key of Object.keys(handlers)) {
    const [capability, method] = key.split('.') as [string, string]
    ;(capabilities[capability] ??= []).push(method)
  }
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const fake: FakeBridge = {
    version: 1,
    platform,
    capabilities,
    calls: [],
    async call(capability, method, args) {
      fake.calls.push({ capability, method, args })
      const handler = handlers[`${capability}.${method}`]
      if (!handler) return { ok: false, error: { code: 'unavailable', message: `No ${capability}.${method}` } }
      try {
        return { ok: true, value: await handler(args) }
      } catch (err) {
        const code = err instanceof NativeError ? err.code : 'failed'
        const reason = err instanceof NativeError && err.reason !== undefined ? { reason: err.reason } : {}
        return { ok: false, error: { code, message: err instanceof Error ? err.message : String(err), ...reason } }
      }
    },
    listen(event, listener) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    emit(event, data) {
      for (const listener of listeners.get(event) ?? []) listener(data)
    },
    uninstall() {
      if (globalThis.hobworkNative === fake) globalThis.hobworkNative = undefined
    },
  }
  globalThis.hobworkNative = fake
  return fake
}
