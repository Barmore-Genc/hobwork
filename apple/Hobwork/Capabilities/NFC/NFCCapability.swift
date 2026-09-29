import Foundation

struct NFCRecord: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case url, text, other
    }

    var type: Kind
    var value: String
}

enum NFCSessionError: Error, Equatable {
    case unavailable
    case cancelled
    case notWritable
    case tooSmall
    case failed(String)
}

/// The system NFC scan sheet, behind a protocol for tests.
@MainActor
protocol NFCTagSession: AnyObject {
    var isAvailable: Bool { get }
    func read() async throws(NFCSessionError) -> [NFCRecord]
    func write(url: URL, text: String?) async throws(NFCSessionError)
}

/// The `nfc` capability. Core NFC only works with the app on screen.
@MainActor
final class NFCCapability: CapabilityHandler {
    nonisolated static let capability = "nfc"

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
        switch method {
        case "read":
            let records = try await run { () throws(NFCSessionError) in try await session.read() }
            return try JSONValue(encoding: Self.readResult(records, host: host()))
        case "write":
            let tag = try args.optionalString("tag")
            guard let url = try URL(string: args.string("url")), NFCTagLink.writableSchemes.contains(url.scheme?.lowercased() ?? "") else {
                throw CallError.badRequest("url must be an http, https, mailto, tel, sms, facetime, facetime-audio or shortcuts URL")
            }
            let text = try args.optionalString("text")
            try await run { () throws(NFCSessionError) in try await session.write(url: url, text: text) }
            return .object(tag.map { ["tag": .string($0), "url": .string(url.absoluteString)] } ?? ["url": .string(url.absoluteString)])
        default:
            throw CallError.unsupported(Self.capability, method)
        }
    }

    struct ReadResult: Codable, Equatable {
        var records: [NFCRecord]
        var tag: String?
    }

    static func readResult(_ records: [NFCRecord], host: URL?) -> ReadResult {
        let tag = records.first { $0.type == .url }
            .flatMap { URL(string: $0.value) }
            .flatMap { NFCTagLink.tag(from: $0, host: host) }
        return ReadResult(records: records, tag: tag)
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
        case .notWritable: CallError(code: "not_writable", message: "This tag can't be written")
        case .tooSmall: CallError(code: "too_small", message: "This tag is too small for the message")
        case let .failed(message): CallError(code: "failed", message: message)
        }
    }
}
