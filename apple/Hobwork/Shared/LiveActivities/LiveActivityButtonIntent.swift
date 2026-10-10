import AppIntents
import Foundation

/// The button of a hob's Live Activity. Part of the app and the widget extension, as Apple
/// requires for Live Activity buttons; iOS runs it in the app. The host runs the hob's route
/// for the button when it gets the `action` event.
struct LiveActivityButtonIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Live Activity Button"
    static let isDiscoverable = false

    @Parameter(title: "Activity")
    var id: String

    init() {}

    init(id: String) {
        self.id = id
    }

    func perform() async throws -> some IntentResult {
        await LiveActivityEvents.action(id: id)
        return .result()
    }
}

/// A button whose hob asked for the app to open, at the activity's page.
struct LiveActivityOpenButtonIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Live Activity Button"
    static let isDiscoverable = false
    static let supportedModes: IntentModes = .foreground(.immediate)

    @Parameter(title: "Activity")
    var id: String

    @Parameter(title: "Hob")
    var hob: String

    @Parameter(title: "Page")
    var path: String?

    init() {}

    init(id: String, hob: String, path: String?) {
        self.id = id
        self.hob = hob
        self.path = path
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        if let link = HobLink(hob: hob, path: path) { HobPageOpener.open(link) }
        await LiveActivityEvents.action(id: id)
        return .result()
    }
}

@MainActor
enum LiveActivityEvents {
    nonisolated static let capability = "liveActivities"

    /// Set by the app, which sends over the socket when it is connected. The widget extension
    /// builds the intents too, and posts to the host directly.
    static var send: ((DeviceEvent) async -> Void)?

    static func action(id: String) async {
        let event = DeviceEvent(capability: capability, name: "action", data: .object(["id": .string(id)]))
        if let send {
            await send(event)
        } else {
            try? await HostAPI.stored?.send(event)
        }
    }
}
