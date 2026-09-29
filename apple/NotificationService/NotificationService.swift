import UserNotifications

/// Runs commands from command pushes and registers the category a notification push
/// names (`aps.category`, `hobwork.<id>`) from the actions in its `hobwork` key.
/// Categories have to exist before iOS shows a notification, and every notification can
/// have its own actions.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.contentHandler = contentHandler
        original = request.content
        let pending = UncheckedSendable((self, content))
        if let push = CommandPush(userInfo: request.content.userInfo), !push.command.foreground {
            Task { @MainActor in
                let (service, content) = pending.value
                if let summary = await CommandPushHandler.run(push.command) { content.body = summary }
                service.deliver(content)
            }
            return
        }
        guard let payload = NotificationPayload(userInfo: request.content.userInfo), payload.actions?.isEmpty == false else {
            deliver(request.content)
            return
        }
        Task {
            let (service, content) = pending.value
            if let category = await NotificationCategories.register(payload) {
                content.categoryIdentifier = category
            }
            service.deliver(content)
        }
    }

    /// Shows the host's own text, which says to open Hobwork if the change did not apply.
    override func serviceExtensionTimeWillExpire() {
        if let original { deliver(original) }
    }

    private func deliver(_ content: UNNotificationContent) {
        contentHandler?(content)
        contentHandler = nil
    }
}

@MainActor
enum CommandPushHandler {
    /// Runs the command, answers the host and returns the notification's new text, or nil
    /// to keep the host's.
    static func run(_ command: DeviceCommand) async -> String? {
        guard let pairing = StoredPairing.load() else { return nil }
        let runner = CommandRunner(log: FileCommandLog())
        BackgroundCapabilities.register(on: runner)
        guard let outcome = await runner.run(command) else { return nil }
        let api = HostAPI(host: pairing.host, token: pairing.credentials.token)
        // When this fails the host sends the command again after the next hello, and the
        // app answers from the command log.
        try? await api.send(DeviceCallResult(id: command.id, outcome: outcome.result))
        return CommandSummary.text(for: command, outcome: outcome)
    }
}

/// The extension gets non-Sendable values from UserNotifications and hands them to one task.
private struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
