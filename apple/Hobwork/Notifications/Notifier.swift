#if os(macOS)
    import AppKit
#else
    import UIKit
#endif
import Foundation
import UserNotifications

/// The `notifications` capability, and what happens when someone acts on a notification.
@MainActor
final class Notifier: NSObject, CapabilityHandler {
    nonisolated static let capability = "notifications"

    struct Response: Equatable, Sendable {
        /// Sent to the host for action buttons.
        var event: DeviceEvent?
        /// Opened in the web view when the tap brings the app to the front.
        var path: String?
        /// A tapped command push, run by the app.
        var command: DeviceCommand?
    }

    private let center: UNUserNotificationCenter
    /// Set by the app model; called for taps and action buttons.
    var onResponse: ((Response) async -> Void)?

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        super.init()
        center.delegate = self
    }

    /// Asks for permission the first time, then registers for pushes either way: the
    /// token works once the person allows notifications in Settings.
    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        #if os(macOS)
            NSApplication.shared.registerForRemoteNotifications()
        #else
            UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        guard method == "send" else {
            throw CallError(code: "unsupported", message: "Unknown method notifications.\(method)")
        }
        guard let args, let notification = try? args.decode(as: HobworkNotification.self) else {
            throw CallError(code: "bad_request", message: "notifications.send needs an id and a title")
        }
        guard await authorizationStatus().allowsNotifications else {
            throw CallError(code: "not_authorized", message: "Notifications are turned off for Hobwork on this device")
        }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        if let body = notification.body { content.body = body }
        content.sound = .default
        if let project = notification.project { content.threadIdentifier = project }
        content.userInfo = [NotificationPayload.userInfoKey: notification.payload.userInfoValue]
        if let category = await NotificationCategories.register(notification.payload) {
            content.categoryIdentifier = category
        }
        do {
            try await center.add(UNNotificationRequest(identifier: notification.id, content: content, trigger: nil))
        } catch {
            throw CallError(code: "failed", message: error.localizedDescription)
        }
        return .object(["id": .string(notification.id)])
    }

    nonisolated static func response(to push: CommandPush, actionIdentifier: String) -> Response? {
        guard actionIdentifier == UNNotificationDefaultActionIdentifier else { return nil }
        return Response(event: nil, path: nil, command: push.command)
    }

    nonisolated static func response(to notification: NotificationPayload?, actionIdentifier: String) -> Response? {
        guard let notification else { return nil }
        switch actionIdentifier {
        case UNNotificationDismissActionIdentifier:
            return nil
        case UNNotificationDefaultActionIdentifier:
            let path = notification.project?.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed).map { "/projects/\($0)" }
            return Response(event: nil, path: path)
        default:
            let data: JSONValue = .object(["id": .string(notification.id), "action": .string(actionIdentifier)])
            return Response(event: DeviceEvent(capability: capability, name: "action", data: data), path: nil)
        }
    }
}

extension UNAuthorizationStatus {
    var allowsNotifications: Bool {
        #if os(iOS)
            [.authorized, .provisional, .ephemeral].contains(self)
        #else
            [.authorized, .provisional].contains(self)
        #endif
    }
}

extension Notifier: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let result = if let push = CommandPush(userInfo: userInfo) {
            Self.response(to: push, actionIdentifier: response.actionIdentifier)
        } else {
            Self.response(to: NotificationPayload(userInfo: userInfo), actionIdentifier: response.actionIdentifier)
        }
        guard let result else { return }
        await deliver(result)
    }

    private func deliver(_ response: Response) async {
        await onResponse?(response)
    }
}
