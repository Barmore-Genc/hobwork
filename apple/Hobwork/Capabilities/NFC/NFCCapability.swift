import Foundation

struct NFCRecord: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case url, text, other
    }

    var type: Kind
    var value: String
}

/// A tag as read: its NDEF records and its hardware ID (UID) as lowercase hex.
struct NFCTagRead: Equatable, Sendable {
    var records: [NFCRecord]
    var uid: String?
}

/// What the system scan sheet says while it waits, and once the tag is done.
struct NFCSheet: Equatable, Sendable {
    var alertMessage: String?
    var successMessage: String?
}

enum NFCSessionError: Error, Equatable {
    case unavailable
    case cancelled
    /// iOS ended the sheet after 60 seconds.
    case timeout
    case busy
    case notWritable
    case tooSmall
    /// The tag did not read back what was written.
    case verifyFailed
    case failed(String)
}

/// Why a scan session ended.
enum NFCScanEnd: Equatable, Sendable {
    case stopped
    case timeout
    case cancelled
    case failed(String)
}

/// The system NFC scan sheet, behind a protocol for tests.
@MainActor
protocol NFCTagSession: AnyObject {
    var isAvailable: Bool { get }
    func read(sheet: NFCSheet) async throws(NFCSessionError) -> NFCTagRead
    /// Writes the link (and text) and reads the tag back in the same tap. Throws
    /// `verifyFailed` when what it reads differs from what was written.
    func write(url: URL, text: String?, sheet: NFCSheet) async throws(NFCSessionError) -> NFCTagRead
    /// Keeps the sheet open and reports each tag, until `stopScan`, iOS ends it, or after the
    /// first tag without `keepOpen`. `onEnd` runs once.
    func startScan(
        sheet: NFCSheet,
        keepOpen: Bool,
        onTag: @escaping @MainActor (NFCTagRead) -> Void,
        onEnd: @escaping @MainActor (NFCScanEnd) -> Void
    ) throws(NFCSessionError)
    func updateScan(alertMessage: String)
    func stopScan(message: String?)
}

/// The `nfc` capability. Core NFC only works with the app on screen.
@MainActor
final class NFCCapability: CapabilityHandler {
    nonisolated static let capability = "nfc"
    static let maxSheetMessage = 200

    private let session: any NFCTagSession
    private let host: () -> URL?

    init(session: any NFCTagSession, host: @escaping () -> URL?) {
        self.session = session
        self.host = host
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        guard session.isAvailable else {
            throw CallError(code: "unsupported", message: "This device can't read NFC tags")
        }
        let args = try Arguments(args, call: "nfc.\(method)")
        let sheet = try Self.sheet(args)
        switch method {
        case "read":
            let read = try await run { () throws(NFCSessionError) in try await session.read(sheet: sheet) }
            return try JSONValue(encoding: Self.readResult(read, host: host()))
        case "write":
            let tag = try args.optionalString("tag")
            guard let url = try URL(string: args.string("url")), NFCTagLink.writableSchemes.contains(url.scheme?.lowercased() ?? "") else {
                throw CallError.badRequest("url must be an http, https, mailto, tel, sms, facetime, facetime-audio or shortcuts URL")
            }
            let text = try args.optionalString("text")
            let read = try await run { () throws(NFCSessionError) in try await session.write(url: url, text: text, sheet: sheet) }
            var result: [String: JSONValue] = ["url": .string(url.absoluteString), "verified": .bool(true)]
            if let tag { result["tag"] = .string(tag) }
            if let uid = read.uid { result["uid"] = .string(uid) }
            return .object(result)
        default:
            throw CallError.unsupported(Self.capability, method)
        }
    }

    static func sheet(_ args: Arguments) throws(CallError) -> NFCSheet {
        try NFCSheet(
            alertMessage: args.has("alertMessage") ? args.nonEmptyString("alertMessage", maxLength: maxSheetMessage) : nil,
            successMessage: args.has("successMessage") ? args.nonEmptyString("successMessage", maxLength: maxSheetMessage) : nil
        )
    }

    struct ReadResult: Codable, Equatable {
        var records: [NFCRecord]
        var tag: String?
        var uid: String?
    }

    static func readResult(_ read: NFCTagRead, host: URL?) -> ReadResult {
        let tag = read.records.first { $0.type == .url }
            .flatMap { URL(string: $0.value) }
            .flatMap { NFCTagLink.tag(from: $0, host: host) }
        return ReadResult(records: read.records, tag: tag, uid: read.uid)
    }

    private func run<Value>(_ body: () async throws(NFCSessionError) -> Value) async throws(CallError) -> Value {
        do {
            return try await body()
        } catch {
            throw Self.callError(error)
        }
    }

    static func callError(_ error: NFCSessionError) -> CallError {
        switch error {
        case .unavailable: CallError(code: "unsupported", message: "This device can't read NFC tags")
        case .cancelled: CallError(code: "cancelled", message: "The NFC scan was cancelled")
        case .timeout: CallError(code: "cancelled", message: "No tag was held near the device in time")
        case .busy: CallError(code: "failed", message: "Another NFC scan is in progress")
        case .notWritable: CallError(code: "not_writable", message: "This tag can't be written")
        case .tooSmall: CallError(code: "too_small", message: "This tag is too small for the message")
        case .verifyFailed: CallError(code: "verify_failed", message: "The tag didn't keep what was written. Try again or use another tag.")
        case let .failed(message): CallError(code: "failed", message: message)
        }
    }

    /// Bridge errors keep the app's code as the reason, so pages can say what went wrong.
    static func bridgeError(_ error: NFCSessionError) -> BridgeError {
        let call = callError(error)
        switch error {
        case .unavailable: return .unavailable(call.message)
        case .cancelled, .timeout: return .cancelled(call.message)
        case .notWritable, .tooSmall, .verifyFailed: return .failed(call.message, reason: call.code)
        case .busy: return .failed(call.message, reason: "busy")
        case .failed: return .failed(call.message)
        }
    }
}
