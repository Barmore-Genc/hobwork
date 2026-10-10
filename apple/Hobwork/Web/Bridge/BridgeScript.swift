import Foundation

/// The user script that defines `window.hobworkNative` in hob pages. `@hobwork/sdk/native`
/// is the API hob UIs use; this is the protocol under it, versioned by `version`.
enum BridgeScript {
    static let handlerName = "hobworkNative"

    /// `appsHosts` limits the script to hob origins. The app checks every message's origin
    /// again, so this only keeps the object out of pages that cannot use it.
    static func source(appsHosts: [String], platform: String, manifest: [String: [String]]) -> String {
        let hosts = JSONValue.array(appsHosts.map { .string("." + $0) }).jsonLiteral
        let capabilities = JSONValue.object(manifest.mapValues { .array($0.map(JSONValue.string)) }).jsonLiteral
        return """
        (() => {
          const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName)
          if (!handler || window.hobworkNative) return
          const host = location.hostname
          const hobOrigin = \(hosts).some((apps) => host.endsWith(apps) && host.length > apps.length && !host.slice(0, -apps.length).includes('.'))
          if (!hobOrigin) return
          const page = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
          const listeners = new Map()
          const post = (capability, method, args) => handler.postMessage({ capability, method, args: args === undefined ? null : args, page })
          const capabilities = \(capabilities)
          for (const methods of Object.values(capabilities)) Object.freeze(methods)
          const bridge = {
            version: \(BridgeRouter.version),
            platform: '\(platform)',
            capabilities: Object.freeze(capabilities),
            page,
            call: (capability, method, args) => post(capability, method, args),
            listen(event, listener) {
              let set = listeners.get(event)
              if (!set) {
                set = new Set()
                listeners.set(event, set)
                post('bridge', 'subscribe', { event }).catch(() => {})
              }
              set.add(listener)
              return () => {
                if (!set.delete(listener) || set.size > 0 || listeners.get(event) !== set) return
                listeners.delete(event)
                post('bridge', 'unsubscribe', { event }).catch(() => {})
              }
            },
            dispatch(event, data) {
              for (const listener of [...(listeners.get(event) || [])]) {
                try {
                  listener(data)
                } catch (error) {
                  setTimeout(() => { throw error })
                }
              }
            },
          }
          Object.defineProperty(window, 'hobworkNative', { value: Object.freeze(bridge) })
        })()
        """
    }
}
