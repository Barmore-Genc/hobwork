import Foundation
import UserNotifications

/// Arguments of a `notifications.send` call.
struct HobworkNotification: Codable, Equatable, Sendable {
    var id: String
    var project: String?
    var title: String
    var body: String?
    var actions: [NotificationAction]?
    /// `passive` or `timeSensitive`; `active` when left out.
    var interruptionLevel: String?
    /// `none` for no sound.
    var sound: String?
    /// The group in Notification Center; the project when left out.
    var thread: String?
    /// A path of the hob's UI the tap opens.
    var open: String?
    /// Goes up with every send and update of the same ID.
    var revision: Int?
    /// Replaces the notification quietly, and only while it still shows.
    var update: Bool?

    var payload: NotificationPayload {
        NotificationPayload(id: id, project: project, actions: actions, open: open, revision: revision)
    }

    var level: UNNotificationInterruptionLevel {
        switch interruptionLevel {
        case "passive": .passive
        case "timeSensitive": .timeSensitive
        default: .active
        }
    }
}

struct NotificationAction: Codable, Equatable, Sendable {
    var id: String
    var title: String
    /// Brings the app to the front, at `open` when set.
    var foreground: Bool?
    var destructive: Bool?
    var open: String?

    init(id: String, title: String, foreground: Bool? = nil, destructive: Bool? = nil, open: String? = nil) {
        self.id = id
        self.title = title
        self.foreground = foreground
        self.destructive = destructive
        self.open = open
    }

    var options: UNNotificationActionOptions {
        var options: UNNotificationActionOptions = []
        if foreground == true { options.insert(.foreground) }
        if destructive == true { options.insert(.destructive) }
        return options
    }
}

/// The `hobwork` key of a notification's `userInfo`: what the app needs when someone
/// acts on it. Pushes carry the title and body only in `aps.alert`.
struct NotificationPayload: Codable, Equatable, Sendable {
    static let userInfoKey = "hobwork"

    var id: String
    var project: String?
    var actions: [NotificationAction]?
    var open: String?
    var revision: Int?

    init(id: String, project: String?, actions: [NotificationAction]?, open: String? = nil, revision: Int? = nil) {
        self.id = id
        self.project = project
        self.actions = actions
        self.open = open
        self.revision = revision
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

    /// What a push of this version shares with the copy the socket brought, so the
    /// second one is dropped. Later versions of the same ID are new.
    static func handledKey(id: String, revision: Int?) -> String {
        guard let revision, revision > 1 else { return id }
        return "\(id)#\(revision)"
    }

    /// Where a tap opens the hob: `/p/<project><path>` follows the host's redirect to the
    /// hob's own address.
    static func link(project: String?, open: String?) -> String? {
        guard let project = project?.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        guard let open, open.hasPrefix("/") else { return "/projects/\(project)" }
        return "/p/\(project)\(open)"
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
            UNNotificationAction(identifier: action.id, title: action.title, options: action.options)
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
