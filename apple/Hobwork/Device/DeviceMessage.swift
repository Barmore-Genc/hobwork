import Foundation

struct PushRegistration: Codable, Equatable, Sendable {
    enum Environment: String, Codable, Sendable {
        case sandbox
        case production
    }

    var token: String
    var environment: Environment
}

struct Hello: Codable, Equatable, Sendable {
    var appVersion: String
    var platform: String
    var capabilities: [String]
    var push: PushRegistration?
}

struct DeviceCall: Codable, Equatable, Sendable {
    /// Echoed back unchanged in the result, whatever JSON type the host uses.
    var id: JSONValue
    var capability: String
    var method: String
    var args: JSONValue?
}

struct CallError: Error, Codable, Equatable, Sendable {
    var code: String
    var message: String
}

struct DeviceCallResult: Equatable, Sendable {
    var id: JSONValue
    var outcome: Result<JSONValue, CallError>
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
    /// A message type this app version does not know. Ignored, so the host can add types.
    case unknown(String)
}

extension DeviceMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, id, ok, value, error
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
        case let .result(result):
            try container.encode("result", forKey: .type)
            try container.encode(result.id, forKey: .id)
            switch result.outcome {
            case let .success(value):
                try container.encode(true, forKey: .ok)
                try container.encode(value, forKey: .value)
            case let .failure(error):
                try container.encode(false, forKey: .ok)
                try container.encode(error, forKey: .error)
            }
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
