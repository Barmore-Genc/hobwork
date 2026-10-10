import Foundation
import UserNotifications

/// `notifications.schedule` and `notifications.cancel`: notifications a hob page shows on
/// this device only, now or at `deliverAt`, without the host. The options match
/// `ctx.device(name).notifications.send` except for actions, which the host runs.
@MainActor
final class LocalNotificationsBridge: BridgeCapability {
    let name = "notifications"
    let methods = ["schedule", "cancel"]
    private let center: UNUserNotificationCenter
    private let now: () -> Date

    init(center: UNUserNotificationCenter = .current(), now: @escaping () -> Date = { Date() }) {
        self.center = center
        self.now = now
    }

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        let hob = context.origin.hob
        switch method {
        case "schedule":
            let request = try Self.request(args, hob: hob, now: now())
            try await authorize()
            do {
                try await center.add(request.request)
            } catch {
                throw BridgeError.failed(error.localizedDescription)
            }
            return .object(["id": .string(request.id)])
        default:
            let id = try Self.id(args.requiredString("id"))
            Notifier.withdraw([Self.identifier(hob: hob, id: id)], from: center)
            return .null
        }
    }

    private func authorize() async throws {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            let allowed = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if !allowed { throw BridgeError.denied("Notifications are turned off for Hobwork on this device") }
        case let status where status.allowsNotifications:
            return
        default:
            throw BridgeError.denied("Notifications are turned off for Hobwork on this device")
        }
    }

    /// Hobs pick IDs, so they are kept apart per hob.
    static func identifier(hob: String, id: String) -> String {
        "local:\(hob):\(id)"
    }

    static func id(_ id: String) throws(BridgeError) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:")
        guard !id.isEmpty, id.count <= 64, id.unicodeScalars.allSatisfy(allowed.contains) else {
            throw .failed("id must be 1 to 64 letters, digits, -, _, . or :")
        }
        return id
    }

    static func request(_ args: JSONValue, hob: String, now: Date) throws(BridgeError) -> (id: String, request: UNNotificationRequest) {
        let id = try args.string("id").map(Self.id) ?? UUID().uuidString.lowercased()
        let title = try args.requiredString("title")
        guard title.utf8.count <= 200 else { throw .failed("title must be at most 200 bytes") }
        let body = try args.string("body")
        if let body, body.utf8.count > 2000 { throw .failed("body must be at most 2,000 bytes") }
        let level = try args.string("interruptionLevel") ?? "active"
        guard ["passive", "active", "timeSensitive"].contains(level) else {
            throw .failed("interruptionLevel must be passive, active or timeSensitive")
        }
        let sound = try args.string("sound") ?? "default"
        guard ["default", "none"].contains(sound) else { throw .failed("sound must be default or none") }
        let open = try args.string("open")
        if let open, !open.hasPrefix("/") { throw .failed("open must be a path such as /spools/42") }
        let thread = try args.string("thread")
        var deliverAt: Date?
        if let text = try args.string("deliverAt") {
            guard let date = ISODate.parse(text) else { throw .failed("deliverAt must be an ISO 8601 date-time") }
            deliverAt = date
        }

        let notification = HobworkNotification(
            id: identifier(hob: hob, id: id), project: hob, title: title, body: body,
            interruptionLevel: level, sound: sound, thread: thread.map { "\(hob)/\($0)" } ?? hob, open: open
        )
        let content = UNMutableNotificationContent()
        content.title = notification.title
        if let body { content.body = body }
        content.sound = sound == "none" || level == "passive" ? nil : .default
        content.interruptionLevel = notification.level
        content.threadIdentifier = notification.thread ?? hob
        content.userInfo = [NotificationPayload.userInfoKey: notification.payload.userInfoValue]
        var trigger: UNNotificationTrigger?
        if let deliverAt, deliverAt.timeIntervalSince(now) >= 1 {
            let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: deliverAt)
            trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        }
        return (id, UNNotificationRequest(identifier: notification.id, content: content, trigger: trigger))
    }
}
