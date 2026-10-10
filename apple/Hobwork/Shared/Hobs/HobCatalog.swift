import Foundation

/// A hob as `GET /api/devices/hobs` lists it: whether it has a widget, and its intents.
/// Hosts before share targets and link rules leave those out.
struct HostHob: Codable, Equatable, Sendable {
    var hob: String
    var widget: Bool
    var intents: [HostHobIntent]
    var share: [HostShareTarget]?
    var appLinks: HobLinkRules?
}

/// A target of the hob in the share sheet ("Share to Hobwork").
struct HostShareTarget: Codable, Equatable, Sendable {
    struct Accepts: Codable, Equatable, Sendable {
        var urls: Bool
        var text: Bool
        /// MIME types (`model/3mf`, `image/*`) and extensions (`.3mf`). Empty: no files.
        var files: [String]
    }

    var id: String
    var title: String
    var accepts: Accepts
    /// The largest file the target's upload takes, when it takes files.
    var maxBytes: Int?
}

struct HostHobIntent: Codable, Equatable, Sendable {
    struct Parameter: Codable, Equatable, Sendable {
        enum Kind: String, Codable, Sendable {
            case text, number, boolean
        }

        var id: String
        var title: String
        var type: Kind
        var optional: Bool
    }

    var id: String
    var title: String
    var parameters: [Parameter]
    var opensApp: Bool
    /// The page the intent opens, a path of the hob's UI.
    var open: String?
    /// False for intents that only open a page.
    var runs: Bool
}

/// What a hob's widget route answers, as the host checked it.
struct WidgetContent: Codable, Equatable, Sendable {
    struct Line: Codable, Equatable, Sendable {
        var text: String
        var detail: String?
        var swatches: [String]?
    }

    /// Without `refreshAt` the widget asks again after this long.
    static let refreshInterval: TimeInterval = 30 * 60

    var title: String
    var subtitle: String?
    var lines: [Line]?
    var swatches: [String]?
    var open: String?
    /// ISO 8601.
    var refreshAt: String?

    func nextRefresh(after now: Date) -> Date {
        guard let date = refreshAt.flatMap(ISODate.parse), date > now else { return now.addingTimeInterval(Self.refreshInterval) }
        return date
    }
}

/// The host's answer to `POST /api/devices/intents` when the intent ran.
struct HobIntentOutcome: Equatable, Sendable {
    var say: String?
    var open: String?
}

/// Errors of the hob intents, worded for the person running them.
enum HobIntentError: Error, Equatable, CustomLocalizedStringResourceConvertible {
    case notPaired
    case unreachable(String)
    case unknownAction
    case failed(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notPaired: "Open Hobwork and connect it to your Hobwork host first."
        case let .unreachable(reason): "Couldn't reach your Hobwork host: \(reason)"
        case .unknownAction: "This action is no longer offered by the hob."
        case let .failed(message): "\(message)"
        }
    }
}

extension HostAPI {
    /// The host this device is paired with, from the Keychain, as the extensions see it.
    static var stored: HostAPI? {
        StoredPairing.load().map { HostAPI(host: $0.host, token: $0.credentials.token) }
    }

    func hobs() async throws -> [HostHob] {
        struct Response: Decodable { var hobs: [HostHob] }
        return try await decode(Response.self, hobsRequest).hobs
    }

    func widget(hob: String) async throws -> WidgetContent {
        try await decode(WidgetContent.self, widgetRequest(hob: hob))
    }

    /// Runs a hob's intent. A refusal by the hob throws `HobIntentError.failed` with its message.
    func runIntent(hob: String, intent: String, parameters: [String: JSONValue]) async throws -> HobIntentOutcome {
        let answer = try await decode(JSONValue.self, intentRequest(hob: hob, intent: intent, parameters: parameters))
        return try Self.intentOutcome(answer)
    }

    /// Starts, updates or ends a Live Activity for a hob page: `start` answers
    /// `{ id, activity }`, `update` `{ updated, devices }`, `end` `{ ended, devices }`.
    func liveActivity(hob: String, op: String, id: String?, args: JSONValue) async throws -> JSONValue {
        try await decode(JSONValue.self, liveActivityRequest(hob: hob, op: op, id: id, args: args))
    }

    var hobsRequest: URLRequest {
        request(method: "GET", path: "api/devices/hobs")
    }

    func widgetRequest(hob: String) -> URLRequest {
        request(method: "GET", path: "api/devices/widgets/\(hob)")
    }

    func intentRequest(hob: String, intent: String, parameters: [String: JSONValue]) -> URLRequest {
        var body: [String: JSONValue] = ["hob": .string(hob), "intent": .string(intent)]
        if !parameters.isEmpty { body["parameters"] = .object(parameters) }
        var request = request(method: "POST", path: "api/devices/intents", body: JSONValue.object(body))
        // Hob handlers may take a while, and Siri waits for the answer.
        request.timeoutInterval = 30
        return request
    }

    func liveActivityRequest(hob: String, op: String, id: String?, args: JSONValue) -> URLRequest {
        var body: [String: JSONValue] = ["hob": .string(hob), "op": .string(op), "args": args]
        if let id { body["id"] = .string(id) }
        return request(method: "POST", path: "api/devices/live-activities", body: JSONValue.object(body))
    }

    static func intentOutcome(_ answer: JSONValue) throws(HobIntentError) -> HobIntentOutcome {
        guard answer["ok"] == .bool(true) else {
            throw .failed(answer["error"]?["message"]?.stringValue ?? "The action didn't work.")
        }
        return HobIntentOutcome(say: answer["say"]?.stringValue, open: answer["open"]?.stringValue)
    }
}
