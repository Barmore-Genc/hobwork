#if os(macOS)
    import AppKit
#else
    import UIKit
#endif
import Foundation

/// Where capabilities show sheets, dialogs and alerts: the web view and what holds it.
@MainActor
protocol BridgePresenter: AnyObject {
    #if os(macOS)
        var bridgeWindow: NSWindow? { get }
        var bridgeView: NSView? { get }
    #else
        var bridgeViewController: UIViewController? { get }
        var bridgeView: UIView? { get }
    #endif
}

/// Runs calls from hob pages through the registered capabilities, and keeps track of which
/// pages listen for which events. Knows nothing of WebKit, so it can be tested.
@MainActor
final class BridgeRouter {
    nonisolated static let version = 1

    /// A frame of a hob page, opaque here (a `WKFrameInfo` in the app).
    typealias Frame = AnyObject
    /// Runs a script in a frame and returns whether the page took it.
    typealias Deliver = @MainActor (Frame, String) async -> Bool

    private struct Subscription {
        var origin: HobOrigin
        var frame: Frame
        var events: Set<String>
    }

    private var capabilities: [String: any BridgeCapability] = [:]
    private let gatekeeper: BridgeGatekeeper
    private let deliver: Deliver
    /// By the random ID each page load of the bridge script picks.
    private var subscriptions: [String: Subscription] = [:]

    init(gatekeeper: BridgeGatekeeper, deliver: @escaping Deliver) {
        self.gatekeeper = gatekeeper
        self.deliver = deliver
    }

    func register(_ capability: any BridgeCapability) {
        capabilities[capability.name] = capability
    }

    /// Capability name to method names, which the page script lists for `native.has`.
    /// Capabilities this device has no method of are left out.
    var manifest: [String: [String]] {
        capabilities.mapValues { $0.methods.sorted() }.filter { !$0.value.isEmpty }
    }

    var permissions: any BridgePermissionStore {
        gatekeeper.store
    }

    /// Permission key to what Settings calls it.
    var permissionLabels: [String: String] {
        var labels: [String: String] = [:]
        for capability in capabilities.values {
            for method in capability.methods {
                if let permission = capability.permission(for: method) { labels[permission.key] = permission.label }
            }
        }
        return labels
    }

    /// Answers a message body `{ capability, method, args, page? }` from a page on `origin`
    /// with `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
    func handle(body: JSONValue, origin: HobOrigin, frame: Frame, presenter: any BridgePresenter) async -> JSONValue {
        do {
            return try .object(["ok": .bool(true), "value": await call(body: body, origin: origin, frame: frame, presenter: presenter)])
        } catch {
            let error = error as? BridgeError ?? .failed(error.localizedDescription)
            return .object(["ok": .bool(false), "error": error.json])
        }
    }

    private func call(body: JSONValue, origin: HobOrigin, frame: Frame, presenter: any BridgePresenter) async throws -> JSONValue {
        let name = try body.requiredString("capability")
        let method = try body.requiredString("method")
        let args = body["args"] ?? .null
        if name == "bridge" {
            return try subscribe(method: method, args: args, page: body.string("page"), origin: origin, frame: frame)
        }
        guard let capability = capabilities[name] else {
            throw BridgeError.unavailable("This app has no \(name)")
        }
        guard capability.methods.contains(method) else {
            throw BridgeError.unavailable("This app has no \(name).\(method)")
        }
        if let permission = capability.permission(for: method),
           !(await gatekeeper.allows(permission, origin: origin, presenter: presenter))
        {
            throw BridgeError.denied("Not allowed for \(origin.hob). Change this in the Hobwork app's settings.")
        }
        let context = BridgeContext(origin: origin, presenter: presenter) { [weak self] event, data in
            self?.emit("\(name).\(event)", data: data, to: origin)
        }
        return try await capability.call(method, args: args, context: context)
    }

    private func subscribe(method: String, args: JSONValue, page: String?, origin: HobOrigin, frame: Frame) throws -> JSONValue {
        guard let page, !page.isEmpty else { throw BridgeError.failed("page is required") }
        let event = try args.requiredString("event")
        // Another hob cannot take over a page's subscriptions by sending its ID.
        let key = "\(origin.string)\n\(page)"
        switch method {
        case "subscribe":
            var subscription = subscriptions[key] ?? Subscription(origin: origin, frame: frame, events: [])
            subscription.frame = frame
            subscription.events.insert(event)
            subscriptions[key] = subscription
        case "unsubscribe":
            subscriptions[key]?.events.remove(event)
            if subscriptions[key]?.events.isEmpty == true { subscriptions[key] = nil }
        default:
            throw BridgeError.unavailable("This app has no bridge.\(method)")
        }
        return .null
    }

    /// Sends `event` with `data` to every page of the hob at `origin` that listens for it.
    /// Pages that are gone are forgotten.
    func emit(_ event: String, data: JSONValue, to origin: HobOrigin) {
        emit(event, data: data) { $0 == origin }
    }

    /// Sends `event` to every listening page of `hob`, on its own origin and its branch previews.
    func emit(_ event: String, data: JSONValue, toHob hob: String) {
        emit(event, data: data) { $0.hob == hob }
    }

    /// Whether a page on `origin` listens for `event`.
    func listens(_ event: String, origin: HobOrigin) -> Bool {
        subscriptions.values.contains { $0.origin == origin && $0.events.contains(event) }
    }

    /// Whether a page of `hob` listens for `event`.
    func listens(_ event: String, hob: String) -> Bool {
        subscriptions.values.contains { $0.origin.hob == hob && $0.events.contains(event) }
    }

    private func emit(_ event: String, data: JSONValue, where matches: (HobOrigin) -> Bool) {
        for (key, subscription) in subscriptions where matches(subscription.origin) && subscription.events.contains(event) {
            let page = String(key.split(separator: "\n", maxSplits: 1).last ?? "")
            let script = Self.dispatchScript(page: page, origin: subscription.origin.string, event: event, data: data)
            Task {
                if await deliver(subscription.frame, script) == false {
                    subscriptions[key] = nil
                }
            }
        }
    }

    /// Forgets every subscription, when the web view loads another top-level page.
    func reset() {
        subscriptions.removeAll()
    }

    var subscriptionCount: Int {
        subscriptions.count
    }

    /// Checks the page and origin again in the frame, since the frame may have navigated
    /// since it subscribed. Returns false when the page is gone.
    static func dispatchScript(page: String, origin: String, event: String, data: JSONValue) -> String {
        let arguments = [JSONValue.string(page), .string(origin), .string(event), data].map(\.jsonLiteral).joined(separator: ", ")
        return """
        ((page, origin, event, data) => {
          const bridge = window.hobworkNative
          if (!bridge || bridge.page !== page || location.origin !== origin) return false
          bridge.dispatch(event, data)
          return true
        })(\(arguments))
        """
    }
}

extension JSONValue {
    /// JSON text, which is also a JavaScript literal.
    var jsonLiteral: String {
        guard let data = try? JSONEncoder().encode(self) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }
}
