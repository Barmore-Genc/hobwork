import Foundation

/// Focus labels the Hobwork Focus filter reported, in the app group.
struct FocusLabels: Codable, Equatable, Sendable {
    var active: [String] = []
    /// The filter has run at least once, so it is attached to a Focus.
    var setUp = false

    static let file = SharedFile(name: "focus.json", empty: FocusLabels())

    /// iOS runs the filter with the Focus's label when the Focus turns on and with no label
    /// when it turns off. Only one Focus is on at a time, so a new label replaces the old one.
    mutating func apply(label: String?) -> [DeviceEvent] {
        let label = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = label.flatMap { $0.isEmpty ? nil : [$0] } ?? []
        let ended = active.filter { !next.contains($0) }
        let started = next.filter { !active.contains($0) }
        active = next
        setUp = true
        return ended.map { Self.event(label: $0, active: false) } + started.map { Self.event(label: $0, active: true) }
    }

    static func event(label: String, active: Bool) -> DeviceEvent {
        DeviceEvent(capability: FocusCapability.capability, name: "changed", data: .object([
            "label": .string(label),
            "active": .bool(active),
        ]))
    }
}

/// The `focus` capability.
@MainActor
final class FocusCapability: CapabilityHandler {
    nonisolated static let capability = "focus"

    private let file: SharedFile<FocusLabels>

    init(file: SharedFile<FocusLabels> = FocusLabels.file) {
        self.file = file
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        guard method == "status" else { throw CallError.unsupported(Self.capability, method) }
        return .object(["active": .array(file.read().active.map { .string($0) })])
    }
}
