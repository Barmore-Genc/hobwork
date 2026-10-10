import ActivityKit
import Foundation
import WidgetKit

struct LiveActivityContent: Equatable, Sendable {
    var state: HobworkActivityAttributes.ContentState
    var staleDate: Date?
    var relevance: Double?
}

enum LiveActivityDismissal: Equatable, Sendable {
    case standard
    case immediate
    case after(Date)
}

/// What the host hears about an activity in `liveActivities` / `state`.
enum LiveActivityPhase: String, Sendable {
    case active, dismissed, ended
}

/// ActivityKit, behind a protocol so tests use a fake.
@MainActor
protocol LiveActivitySystem: AnyObject {
    var areEnabled: Bool { get }
    var frequentPushesEnabled: Bool { get }
    /// Returns ActivityKit's ID of the new activity.
    func start(_ attributes: HobworkActivityAttributes, content: LiveActivityContent) throws -> String
    /// Changes every running activity with the host's ID, and returns whether there was one.
    func update(id: String, content: LiveActivityContent) async -> Bool
    func end(id: String, content: LiveActivityContent?, dismissal: LiveActivityDismissal) async -> Bool
}

/// The `liveActivities` capability: the host's `start`, `update` and `end` calls over the
/// socket, and starts for hob pages through the bridge. `id` is the host's activity ID.
@MainActor
final class LiveActivities: CapabilityHandler {
    nonisolated static let capability = LiveActivityEvents.capability

    let system: any LiveActivitySystem
    private let now: () -> Date

    init(system: any LiveActivitySystem, now: @escaping () -> Date = { Date() }) {
        self.system = system
        self.now = now
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        switch method {
        case "start": try await start(args)
        case "update": try await update(args)
        case "end": try await end(args)
        default: throw CallError.unsupported(Self.capability, method)
        }
    }

    /// `{ hob, id, state, staleAt?, relevance? }` → `{ activity }`. Activities already running
    /// under the ID end first: the host starts them again before iOS's 8 hour limit.
    func start(_ args: JSONValue?) async throws -> JSONValue {
        let arguments = try Arguments(args, call: "liveActivities.start")
        let attributes = try HobworkActivityAttributes(hob: arguments.string("hob"), id: arguments.string("id"))
        let content = try LiveActivityContent(
            state: Self.state(arguments.raw("state"), call: arguments.call),
            staleDate: Self.date(arguments, "staleAt"),
            relevance: Self.number(arguments, "relevance")
        )
        guard system.areEnabled else { throw CallError.notAuthorized("Live Activities are turned off for Hobwork on this device") }
        _ = await system.end(id: attributes.id, content: nil, dismissal: .immediate)
        do {
            return try .object(["activity": .string(system.start(attributes, content: content))])
        } catch {
            throw CallError(code: "failed", message: error.localizedDescription)
        }
    }

    /// `{ id, state, staleAt?, relevance? }` → `{ updated }`.
    func update(_ args: JSONValue?) async throws -> JSONValue {
        let arguments = try Arguments(args, call: "liveActivities.update")
        let id = try arguments.string("id")
        let content = try LiveActivityContent(
            state: Self.state(arguments.raw("state"), call: arguments.call),
            staleDate: Self.date(arguments, "staleAt"),
            relevance: Self.number(arguments, "relevance")
        )
        return .object(["updated": .bool(await system.update(id: id, content: content))])
    }

    /// `{ id, state?, dismissAt? }` → `{ ended }`.
    func end(_ args: JSONValue?) async throws -> JSONValue {
        let arguments = try Arguments(args, call: "liveActivities.end")
        let id = try arguments.string("id")
        let content = try arguments.has("state") ? LiveActivityContent(state: Self.state(arguments.raw("state"), call: arguments.call)) : nil
        let dismissal: LiveActivityDismissal = switch try Self.date(arguments, "dismissAt") {
        case nil: .standard
        case let date? where date <= now(): .immediate
        case let date?: .after(date)
        }
        return .object(["ended": .bool(await system.end(id: id, content: content, dismissal: dismissal))])
    }

    static func state(_ value: JSONValue?, call: String) throws(CallError) -> HobworkActivityAttributes.ContentState {
        guard let value, value.objectValue != nil,
              let state = try? JSONDecoder().decode(HobworkActivityAttributes.ContentState.self, from: JSONEncoder().encode(value))
        else { throw .badRequest("\(call) needs state with a title") }
        return state
    }

    private static func number(_ arguments: Arguments, _ key: String) throws(CallError) -> Double? {
        guard arguments.has(key) else { return nil }
        guard let number = arguments.raw(key)?.numberValue, number.isFinite else { throw .badRequest("\(key) must be a number") }
        return number
    }

    /// Unix seconds.
    private static func date(_ arguments: Arguments, _ key: String) throws(CallError) -> Date? {
        try number(arguments, key).map { Date(timeIntervalSince1970: $0) }
    }
}

/// The last push-to-start token registered with the relay, so a launch does not register
/// and report it again.
struct StartTokenRecord: Codable, Equatable, Sendable {
    var host: URL
    var grant: String
    /// Hex.
    var token: String
    /// The relay's ID for it, which the host pushes to.
    var id: String
}

/// Registers ActivityKit's tokens with the relay under the pairing's grant and tells the
/// host the relay's IDs, which are all it needs to push to them.
@MainActor
final class LiveActivityTokens {
    private let relay: RelayClient
    private let store: PushStore
    private let memory: SharedFile<StartTokenRecord?>
    private let host: () -> URL?
    private let send: (DeviceEvent) async -> Void
    private var startToken: String?
    /// By ActivityKit's ID.
    private var activityTokens: [String: (grant: String, id: String)] = [:]

    init(
        relay: RelayClient,
        store: PushStore = PushStore(),
        memory: SharedFile<StartTokenRecord?> = SharedFile(name: "live-activity-start-token.json", empty: nil),
        host: @escaping () -> URL?,
        send: @escaping (DeviceEvent) async -> Void
    ) {
        self.relay = relay
        self.store = store
        self.memory = memory
        self.host = host
        self.send = send
    }

    private var context: (host: URL, auth: RelayAuth, grant: String)? {
        guard let host = host(), let registration = store.registration(), registration.status == .active,
              let grant = store.pairing(for: host)?.grant?.id
        else { return nil }
        return (host, registration.auth, grant)
    }

    func startTokenArrived(_ token: Data) async {
        startToken = token.hex
        await reportStartToken()
    }

    /// Registers the push-to-start token again when the grant or host changed.
    func reportStartToken() async {
        guard let token = startToken else { return }
        guard let context else {
            if let record = memory.read(), record.host == host() {
                memory.update { $0 = nil }
                await send(event("startToken", ["token": .null]))
            }
            return
        }
        if let record = memory.read(), record.host == context.host, record.grant == context.grant, record.token == token { return }
        guard let id = try? await relay.createActivityToken(context.auth, grant: context.grant, kind: .start, token: token) else { return }
        memory.update { $0 = StartTokenRecord(host: context.host, grant: context.grant, token: token, id: id) }
        await send(event("startToken", ["token": .string(id)]))
    }

    func activityTokenArrived(activity: String, id: String, token: Data) async {
        guard let context,
              let tokenId = try? await relay.createActivityToken(context.auth, grant: context.grant, kind: .update, token: token.hex)
        else { return }
        activityTokens[activity] = (context.grant, tokenId)
        await activityChanged(activity: activity, id: id, phase: .active)
    }

    func activityChanged(activity: String, id: String, phase: LiveActivityPhase) async {
        var data: [String: JSONValue] = ["id": .string(id), "activity": .string(activity), "state": .string(phase.rawValue)]
        if let token = activityTokens[activity] { data["token"] = .string(token.id) }
        await send(event("state", data))
        guard phase != .active, let token = activityTokens.removeValue(forKey: activity), let auth = store.registration()?.auth else { return }
        try? await relay.deleteActivityToken(auth, grant: token.grant, id: token.id)
    }

    private func event(_ name: String, _ data: [String: JSONValue]) -> DeviceEvent {
        DeviceEvent(capability: LiveActivities.capability, name: name, data: .object(data))
    }
}

typealias HobActivity = Activity<HobworkActivityAttributes>

/// The real ActivityKit. Watches activities, including ones push-to-start began while the app
/// was not running, for their tokens and their end.
@MainActor
final class ActivityKitSystem: LiveActivitySystem {
    private var tokens: LiveActivityTokens?
    private var observed: Set<String> = []

    var areEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    var frequentPushesEnabled: Bool { ActivityAuthorizationInfo().frequentPushesEnabled }

    func start(_ attributes: HobworkActivityAttributes, content: LiveActivityContent) throws -> String {
        let activity = try HobActivity.request(attributes: attributes, content: Self.content(content), pushType: .token)
        observe(activity)
        return activity.id
    }

    func update(id: String, content: LiveActivityContent) async -> Bool {
        let matching = HobActivity.activities.filter { $0.attributes.id == id }
        for activity in matching {
            // Activity is not Sendable, though ActivityKit expects updates from any task.
            nonisolated(unsafe) let activity = activity
            await activity.update(Self.content(content))
        }
        return !matching.isEmpty
    }

    func end(id: String, content: LiveActivityContent?, dismissal: LiveActivityDismissal) async -> Bool {
        let matching = HobActivity.activities.filter { $0.attributes.id == id }
        let policy: ActivityUIDismissalPolicy = switch dismissal {
        case .standard: .default
        case .immediate: .immediate
        case let .after(date): .after(date)
        }
        for activity in matching {
            nonisolated(unsafe) let activity = activity
            await activity.end(content.map(Self.content), dismissalPolicy: policy)
        }
        return !matching.isEmpty
    }

    func watch(_ tokens: LiveActivityTokens) {
        self.tokens = tokens
        Task {
            for await token in HobActivity.pushToStartTokenUpdates {
                await tokens.startTokenArrived(token)
            }
        }
        Task { [weak self] in
            for await activity in HobActivity.activityUpdates {
                self?.observe(activity)
            }
        }
        for activity in HobActivity.activities {
            observe(activity)
        }
    }

    private func observe(_ activity: HobActivity) {
        let id = activity.attributes.id
        guard let tokens, !id.isEmpty, observed.insert(activity.id).inserted else { return }
        let activityId = activity.id
        Task {
            for await token in activity.pushTokenUpdates {
                await tokens.activityTokenArrived(activity: activityId, id: id, token: token)
            }
        }
        Task {
            for await state in activity.activityStateUpdates {
                switch state {
                case .active: await tokens.activityChanged(activity: activityId, id: id, phase: .active)
                case .dismissed: await tokens.activityChanged(activity: activityId, id: id, phase: .dismissed)
                case .ended: await tokens.activityChanged(activity: activityId, id: id, phase: .ended)
                default: break
                }
            }
        }
    }

    private static func content(_ content: LiveActivityContent) -> ActivityContent<HobworkActivityAttributes.ContentState> {
        ActivityContent(state: content.state, staleDate: content.staleDate, relevanceScore: content.relevance ?? 0)
    }
}

/// The `widgets` capability: the host asks for fresh content after a hob's widget changed.
@MainActor
final class WidgetsCapability: CapabilityHandler {
    nonisolated static let capability = "widgets"

    private let reload: () -> Void

    init(reload: @escaping () -> Void = WidgetReloader.reloadAll) {
        self.reload = reload
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        guard method == "reload" else { throw CallError.unsupported(Self.capability, method) }
        reload()
        return .object([:])
    }
}

enum WidgetReloader {
    static func reloadAll() {
        WidgetCenter.shared.reloadAllTimelines()
        ControlCenter.shared.reloadAllControls()
    }
}
