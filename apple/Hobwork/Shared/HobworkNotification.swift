import Foundation
import UserNotifications

/// Arguments of a `notifications.send` call.
struct HobworkNotification: Codable, Equatable, Sendable {
    var id: String
    var project: String?
    var title: String
    var body: String?
    var actions: [NotificationAction]?

    var payload: NotificationPayload {
        NotificationPayload(id: id, project: project, actions: actions)
    }
}

struct NotificationAction: Codable, Equatable, Sendable {
    var id: String
    var title: String
}

/// The `hobwork` key of a notification's `userInfo`: what the app needs when someone
/// acts on it. Pushes carry the title and body only in `aps.alert`.
struct NotificationPayload: Codable, Equatable, Sendable {
    static let userInfoKey = "hobwork"

    var id: String
    var project: String?
    var actions: [NotificationAction]?

    init(id: String, project: String?, actions: [NotificationAction]?) {
        self.id = id
        self.project = project
        self.actions = actions
    }

    /// Pushes carry the payload as a dictionary, local notifications as a JSON string
    /// (`userInfo` must be a property list, and JSON `null` is not one).
    init?(userInfo: [AnyHashable: Any]) {
        let raw = userInfo[Self.userInfoKey]
        let payload: NotificationPayload? = if let string = raw as? String {
            try? JSONDecoder().decode(NotificationPayload.self, from: Data(string.utf8))
        } else if let raw, let value = JSONValue(foundationValue: raw) {
            try? value.decode(as: NotificationPayload.self)
        } else {
            nil
        }
        guard let payload else { return nil }
        self = payload
    }

    var userInfoValue: String {
        String(decoding: (try? JSONEncoder().encode(self)) ?? Data("{}".utf8), as: UTF8.self)
    }
}

enum NotificationCategories {
    static let prefix = "hobwork."

    /// The host names the category after the notification (`aps.category` in pushes),
    /// since every notification can have its own actions.
    static func identifier(for notificationID: String) -> String {
        prefix + notificationID
    }

    static func category(for payload: NotificationPayload) -> UNNotificationCategory {
        let buttons = (payload.actions ?? []).map { action in
            UNNotificationAction(identifier: action.id, title: action.title, options: [])
        }
        return UNNotificationCategory(identifier: identifier(for: payload.id), actions: buttons, intentIdentifiers: [])
    }

    /// Registers the category for a notification with actions and returns its identifier.
    /// Categories of notifications no longer in Notification Center are dropped, so they
    /// do not pile up.
    static func register(_ payload: NotificationPayload) async -> String? {
        guard let actions = payload.actions, !actions.isEmpty else { return nil }
        let center = UNUserNotificationCenter.current()
        let category = category(for: payload)
        let delivered = Set(await center.deliveredNotifications().map(\.request.content.categoryIdentifier))
        let existing = await center.notificationCategories()
        var categories = existing.filter {
            $0.identifier != category.identifier && (!$0.identifier.hasPrefix(prefix) || delivered.contains($0.identifier))
        }
        categories.insert(category)
        center.setNotificationCategories(categories)
        // The setter returns before the change lands; reading back waits for it, so the
        // notification shown next already has its buttons.
        _ = await center.notificationCategories()
        return category.identifier
    }
}
