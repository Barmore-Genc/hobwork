import UserNotifications

/// Registers the category a push names (`aps.category`, `hobwork.<id>`) from the actions
/// in its `hobwork` key. Categories have to exist before iOS shows a notification, and
/// every notification can have its own actions.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
              let payload = NotificationPayload(userInfo: request.content.userInfo),
              payload.actions?.isEmpty == false
        else {
            contentHandler(request.content)
            return
        }
        self.contentHandler = contentHandler
        original = request.content
        let pending = UncheckedSendable((self, content))
        Task {
            let (service, content) = pending.value
            if let category = await NotificationCategories.register(payload) {
                content.categoryIdentifier = category
            }
            service.deliver(content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let original { deliver(original) }
    }

    private func deliver(_ content: UNNotificationContent) {
        contentHandler?(content)
        contentHandler = nil
    }
}

/// The extension gets non-Sendable values from UserNotifications and hands them to one task.
private struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
