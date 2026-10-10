import Foundation

/// Errors hob UIs see as `NativeError` with the same code.
struct BridgeError: Error, Equatable, Sendable {
    enum Code: String, Sendable {
        /// Not in this app, not on this platform, or not set up on this device.
        case unavailable
        /// The person said no, here or in Settings.
        case denied
        /// The person closed the sheet or dialog.
        case cancelled
        /// Anything else, including bad arguments.
        case failed
    }

    var code: Code
    var message: String

    static func unavailable(_ message: String) -> BridgeError { BridgeError(code: .unavailable, message: message) }
    static func denied(_ message: String) -> BridgeError { BridgeError(code: .denied, message: message) }
    static func cancelled(_ message: String) -> BridgeError { BridgeError(code: .cancelled, message: message) }
    static func failed(_ message: String) -> BridgeError { BridgeError(code: .failed, message: message) }
}

/// A question the person answers once per hob before a sensitive method first runs.
struct BridgePermission: Sendable {
    /// What the answer is remembered under, such as `clipboard.read`.
    var key: String
    /// Shown in Settings, such as "Read the clipboard".
    var label: String
    /// The alert's text, with the hob's name.
    var title: @Sendable (String) -> String
    var message: String
}

/// What a capability can use while it handles a call.
@MainActor
struct BridgeContext {
    var origin: HobOrigin
    /// Where sheets and dialogs are shown.
    var presenter: any BridgePresenter
    /// Sends an event to the pages of this hob that listen for it, e.g.
    /// `emit("nfc.scan", data)` reaches `native.on('nfc.scan', ...)`.
    var emit: (String, JSONValue) -> Void
}

/// A group of native features hob UIs call through `window.hobworkNative`, such as
/// `haptics`. The bridge registers one instance per capability.
@MainActor
protocol BridgeCapability: AnyObject {
    /// The name pages call it by, and the prefix of its events.
    var name: String { get }
    var methods: [String] { get }
    /// The question to ask before `method` runs for a hob the first time, or nil when it
    /// needs none.
    func permission(for method: String) -> BridgePermission?
    /// Runs a call. Errors other than `BridgeError` reach the page as `failed`.
    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue
}

extension BridgeCapability {
    func permission(for method: String) -> BridgePermission? { nil }
}

extension JSONValue {
    var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    func string(_ key: String) throws(BridgeError) -> String? {
        guard let value = self[key], value != .null else { return nil }
        guard let string = value.stringValue else { throw .failed("\(key) must be a string") }
        return string
    }

    func requiredString(_ key: String) throws(BridgeError) -> String {
        guard let string = try string(key), !string.isEmpty else { throw .failed("\(key) is required") }
        return string
    }

    func number(_ key: String) throws(BridgeError) -> Double? {
        guard let value = self[key], value != .null else { return nil }
        guard let number = value.numberValue, number.isFinite else { throw .failed("\(key) must be a number") }
        return number
    }

    func bool(_ key: String) throws(BridgeError) -> Bool? {
        guard let value = self[key], value != .null else { return nil }
        guard let bool = value.boolValue else { throw .failed("\(key) must be true or false") }
        return bool
    }

    /// Base64 bytes from the SDK, which encodes Blobs and ArrayBuffers this way.
    func data(_ key: String, limit: Int) throws(BridgeError) -> Data? {
        guard let base64 = try string(key) else { return nil }
        guard base64.count <= (limit + 2) / 3 * 4 else { throw .failed("\(key) is larger than \(limit / 1_000_000) MB") }
        guard let data = Data(base64Encoded: base64) else { throw .failed("\(key) must be base64") }
        return data
    }
}
