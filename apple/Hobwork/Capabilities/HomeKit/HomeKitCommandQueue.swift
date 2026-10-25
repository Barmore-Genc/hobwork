import Foundation

/// Notification responses can arrive before scene activation. Return from the notification
/// callback before running commands, so an approval alert cannot hold up activation.
@MainActor
final class HomeKitCommandQueue {
    private let isActive: () -> Bool
    private let run: (DeviceCommand) async -> Void
    private var pending: [DeviceCommand] = []
    private var draining = false

    init(isActive: @escaping () -> Bool, run: @escaping (DeviceCommand) async -> Void) {
        self.isActive = isActive
        self.run = run
    }

    func submit(_ command: DeviceCommand) {
        if !pending.contains(where: { $0.key == command.key }) { pending.append(command) }
        sceneBecameActive()
    }

    func sceneBecameActive() {
        guard isActive(), !draining, !pending.isEmpty else { return }
        draining = true
        Task {
            while isActive(), !pending.isEmpty {
                await run(pending.removeFirst())
            }
            draining = false
        }
    }

    func removeAll() {
        pending = []
    }
}
