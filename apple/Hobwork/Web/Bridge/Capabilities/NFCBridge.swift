import Foundation

/// `nfc` for hob pages: `read` and `write` on this device's scan sheet, scan sessions that
/// report tag after tag (`nfc.tag`, then `nfc.ended`), and on devices without NFC (iPads,
/// Macs) `read` and `write` with `device`, which the host hands to another of the person's
/// devices. Writing asks the person once per hob.
@MainActor
final class NFCBridge: BridgeCapability {
    /// Runs `nfc.<method>` on another of the person's devices through the host and returns
    /// the host's `{ ok, device?, value? | error? }`.
    typealias Handoff = (_ hob: String, _ device: String, _ method: String, _ args: JSONValue) async throws -> JSONValue

    let name = "nfc"
    private let handoff: Handoff
    private let host: () -> URL?
    #if os(iOS)
        private let session: (any NFCTagSession)?
        private var scan: (id: String, origin: HobOrigin)?

        init(session: (any NFCTagSession)?, host: @escaping () -> URL?, handoff: @escaping Handoff) {
            self.session = session
            self.host = host
            self.handoff = handoff
        }
    #else
        init(host: @escaping () -> URL?, handoff: @escaping Handoff) {
            self.host = host
            self.handoff = handoff
        }
    #endif

    var methods: [String] {
        #if os(iOS)
            if session?.isAvailable == true { return ["read", "write", "startSession", "updateSession", "stopSession"] }
        #endif
        return ["read", "write"]
    }

    func permission(for method: String) -> BridgePermission? {
        guard method == "write" else { return nil }
        return BridgePermission(
            key: "nfc.write",
            label: "Write NFC tags",
            title: { "Let “\($0)” write NFC tags?" },
            message: writeMessage
        )
    }

    private var writeMessage: String {
        #if os(iOS)
            if session?.isAvailable == true { return "It can then write links to tags you hold near your \(DeviceModel.name)." }
        #endif
        return "It can then write links to tags with your other devices that read NFC."
    }

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        if let device = try args.string("device"), method == "read" || method == "write" {
            return try await handOff(method, device: device, args: args, hob: context.origin.hob)
        }
        #if os(iOS)
            guard let session, session.isAvailable else {
                throw BridgeError.unavailable("This device can't read NFC tags. Pass device to use another of your devices.")
            }
            let sheet = try Self.sheet(args)
            switch method {
            case "read":
                let read = try await run { () throws(NFCSessionError) in try await session.read(sheet: sheet) }
                return try Self.tagJSON(read, host: host())
            case "write":
                let link = try args.requiredString("url")
                guard let url = URL(string: link), NFCTagLink.writableSchemes.contains(url.scheme?.lowercased() ?? "") else {
                    throw BridgeError.failed("url must be an http, https, mailto, tel, sms, facetime, facetime-audio or shortcuts link")
                }
                guard link.utf8.count <= 2048 else { throw BridgeError.failed("url must be at most 2,048 bytes") }
                let text = try args.string("text")
                if let text, text.utf8.count > 1024 { throw BridgeError.failed("text must be at most 1,024 bytes") }
                let read = try await run { () throws(NFCSessionError) in try await session.write(url: url, text: text, sheet: sheet) }
                var result: [String: JSONValue] = ["url": .string(url.absoluteString), "verified": .bool(true)]
                if let uid = read.uid { result["uid"] = .string(uid) }
                return .object(result)
            case "startSession":
                return try startSession(args: args, sheet: sheet, session: session, context: context)
            case "updateSession":
                try current(args, origin: context.origin)
                session.updateScan(alertMessage: try Self.text(args, "alertMessage") ?? "")
                return .null
            default:
                try current(args, origin: context.origin)
                session.stopScan(message: try Self.text(args, "successMessage"))
                return .null
            }
        #else
            throw BridgeError.unavailable("This device can't read NFC tags. Pass device to use another of your devices.")
        #endif
    }

    private func handOff(_ method: String, device: String, args: JSONValue, hob: String) async throws -> JSONValue {
        var forwarded = args.objectValue ?? [:]
        forwarded["device"] = nil
        let reply: JSONValue
        do {
            reply = try await handoff(hob, device, method, .object(forwarded))
        } catch {
            throw BridgeError.failed("Couldn't reach your Hobwork host: \(error.localizedDescription)", reason: "unreachable")
        }
        return try Self.handoffResult(reply)
    }

    /// The host's answer to a hand-off, as the page gets it.
    static func handoffResult(_ reply: JSONValue) throws(BridgeError) -> JSONValue {
        if reply["ok"]?.boolValue == true {
            var value = reply["value"]?.objectValue ?? [:]
            if let device = reply["device"] { value["device"] = device }
            return .object(value)
        }
        let code = reply["error"]?["code"]?.stringValue ?? "failed"
        let message = reply["error"]?["message"]?.stringValue ?? "The other device couldn't do it"
        switch code {
        case "cancelled": throw .cancelled(message)
        case "unknown_device", "unreachable", "unsupported": throw BridgeError(code: .unavailable, message: message, reason: code)
        default: throw .failed(message, reason: code)
        }
    }

    static func text(_ args: JSONValue, _ key: String) throws(BridgeError) -> String? {
        guard let text = try args.string(key) else { return nil }
        guard !text.isEmpty, text.count <= 200 else { throw .failed("\(key) must be 1 to 200 characters") }
        return text
    }

    #if os(iOS)
        static func sheet(_ args: JSONValue) throws(BridgeError) -> NFCSheet {
            try NFCSheet(alertMessage: text(args, "alertMessage"), successMessage: text(args, "successMessage"))
        }

        static func tagJSON(_ read: NFCTagRead, host: URL?) throws -> JSONValue {
            try JSONValue(encoding: NFCCapability.readResult(read, host: host))
        }

        private func startSession(args: JSONValue, sheet: NFCSheet, session: any NFCTagSession, context: BridgeContext) throws -> JSONValue {
            let id = UUID().uuidString.lowercased()
            let keepOpen = try args.bool("keepOpen") ?? false
            let host = host()
            let emit = context.emit
            do {
                try session.startScan(
                    sheet: sheet,
                    keepOpen: keepOpen,
                    onTag: { read in
                        guard var data = (try? Self.tagJSON(read, host: host))?.objectValue else { return }
                        data["session"] = .string(id)
                        emit("tag", .object(data))
                    },
                    onEnd: { [weak self] end in
                        if self?.scan?.id == id { self?.scan = nil }
                        var data: [String: JSONValue] = ["session": .string(id)]
                        switch end {
                        case .stopped: data["reason"] = .string("stopped")
                        case .timeout: data["reason"] = .string("timeout")
                        case .cancelled: data["reason"] = .string("cancelled")
                        case let .failed(message):
                            data["reason"] = .string("failed")
                            data["message"] = .string(message)
                        }
                        emit("ended", .object(data))
                    }
                )
            } catch {
                throw NFCCapability.bridgeError(error)
            }
            scan = (id, context.origin)
            return .object(["session": .string(id)])
        }

        /// Only the page's own hob may change or stop its session.
        private func current(_ args: JSONValue, origin: HobOrigin) throws {
            let id = try args.requiredString("session")
            guard let scan, scan.id == id, scan.origin.hob == origin.hob else { throw BridgeError.failed("This scan session has ended") }
        }

        private func run<Value>(_ body: () async throws(NFCSessionError) -> Value) async throws(BridgeError) -> Value {
            do {
                return try await body()
            } catch {
                throw NFCCapability.bridgeError(error)
            }
        }
    #endif
}
