import Foundation

/// Events waiting for a connection. Notification actions can arrive while the app
/// runs in the background without a socket, so the queue survives relaunches.
@MainActor
protocol EventQueue: AnyObject {
    var events: [DeviceEvent] { get }
    func append(_ event: DeviceEvent)
    func removeFirst()
    func removeAll()
}

@MainActor
final class MemoryEventQueue: EventQueue {
    private(set) var events: [DeviceEvent] = []

    func append(_ event: DeviceEvent) { events.append(event) }
    func removeFirst() { if !events.isEmpty { events.removeFirst() } }
    func removeAll() { events.removeAll() }
}

@MainActor
final class StoredEventQueue: EventQueue {
    /// Keeps a device that stays offline for a long time from growing the queue forever.
    static let limit = 200

    private let defaults: UserDefaults
    private let key: String
    private(set) var events: [DeviceEvent]

    init(defaults: UserDefaults = .standard, key: String = "pendingDeviceEvents") {
        self.defaults = defaults
        self.key = key
        events = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([DeviceEvent].self, from: $0) } ?? []
    }

    func append(_ event: DeviceEvent) {
        events.append(event)
        if events.count > Self.limit { events.removeFirst(events.count - Self.limit) }
        save()
    }

    func removeFirst() {
        guard !events.isEmpty else { return }
        events.removeFirst()
        save()
    }

    func removeAll() {
        events.removeAll()
        save()
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(events), forKey: key)
    }
}
