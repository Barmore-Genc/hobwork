import Foundation

struct Hello: Codable, Equatable, Sendable {
    /// `platform` in pairing and `hello`.
    static var platform: String {
        #if os(macOS)
            "macos"
        #else
            "ios"
        #endif
    }

    var appVersion: String
    var platform: String
    var capabilities: [String]
    /// Left out while there is no grant.
    var push: HostPushGrant?
}

struct DeviceCall: Codable, Equatable, Sendable {
    /// Echoed back unchanged in the result, whatever JSON type the host uses.
    var id: JSONValue
    var capability: String
    var method: String
    var args: JSONValue?
    var expiresAt: String?

    init(id: JSONValue, capability: String, method: String, args: JSONValue?, expiresAt: String? = nil) {
        self.id = id
        self.capability = capability
        self.method = method
        self.args = args
        self.expiresAt = expiresAt
    }
}

struct CallError: Error, Codable, Equatable, Sendable, LocalizedError {
    var code: String
    var message: String

    var errorDescription: String? { message }

    static func badRequest(_ message: String) -> CallError {
        CallError(code: "bad_request", message: message)
    }

    static func notAuthorized(_ message: String) -> CallError {
        CallError(code: "not_authorized", message: message)
    }

    static func unsupported(_ capability: String, _ method: String) -> CallError {
        CallError(code: "unsupported", message: "Unknown method \(capability).\(method)")
    }
}

/// `{ id, ok: true, value }` or `{ id, ok: false, error }`, over the socket (with a
/// `type`) or with `POST /api/devices/results`.
struct DeviceCallResult: Equatable, Sendable, Encodable {
    var id: JSONValue
    var outcome: Result<JSONValue, CallError>

    private enum CodingKeys: String, CodingKey {
        case id, ok, value, error
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        switch outcome {
        case let .success(value):
            try container.encode(true, forKey: .ok)
            try container.encode(value, forKey: .value)
        case let .failure(error):
            try container.encode(false, forKey: .ok)
            try container.encode(error, forKey: .error)
        }
    }
}

struct DeviceEvent: Codable, Equatable, Sendable {
    var capability: String
    var name: String
    var data: JSONValue
}

enum DeviceMessage: Equatable, Sendable {
    case hello(Hello)
    case call(DeviceCall)
    case result(DeviceCallResult)
    case event(DeviceEvent)
    case ping
    case pong
    /// The host's push keys, nil when it has no relay.
    case push(HostPushKeys?)
    /// A message type this app version does not know. Ignored, so the host can add types.
    case unknown(String)
}

extension DeviceMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, id, ok, value, error, relay
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "hello": self = try .hello(Hello(from: decoder))
        case "call": self = try .call(DeviceCall(from: decoder))
        case "event": self = try .event(DeviceEvent(from: decoder))
        case "ping": self = .ping
        case "pong": self = .pong
        case "push":
            if try !container.contains(.relay) || container.decodeNil(forKey: .relay) {
                self = .push(nil)
            } else {
                self = try .push(HostPushKeys(from: decoder))
            }
        case "result":
            let id = try container.decode(JSONValue.self, forKey: .id)
            if try container.decode(Bool.self, forKey: .ok) {
                let value = try container.decodeIfPresent(JSONValue.self, forKey: .value) ?? .null
                self = .result(DeviceCallResult(id: id, outcome: .success(value)))
            } else {
                let error = try container.decode(CallError.self, forKey: .error)
                self = .result(DeviceCallResult(id: id, outcome: .failure(error)))
            }
        default: self = .unknown(type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .hello(hello):
            try container.encode("hello", forKey: .type)
            try hello.encode(to: encoder)
        case let .call(call):
            try container.encode("call", forKey: .type)
            try call.encode(to: encoder)
        case let .event(event):
            try container.encode("event", forKey: .type)
            try event.encode(to: encoder)
        case .ping:
            try container.encode("ping", forKey: .type)
        case .pong:
            try container.encode("pong", forKey: .type)
        case let .push(keys):
            try container.encode("push", forKey: .type)
            if let keys { try keys.encode(to: encoder) } else { try container.encodeNil(forKey: .relay) }
        case let .result(result):
            try container.encode("result", forKey: .type)
            try result.encode(to: encoder)
        case let .unknown(type):
            try container.encode(type, forKey: .type)
        }
    }

    static func decode(_ text: String) throws -> DeviceMessage {
        try JSONDecoder().decode(DeviceMessage.self, from: Data(text.utf8))
    }

    func encoded() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return String(decoding: try encoder.encode(self), as: UTF8.self)
    }
}
