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
    private let handled: HandledPushLog
    /// Set by the app model; called for taps and action buttons.
    var onResponse: ((Response) async -> Void)?
    /// Set by the app model; called with the nonce of a relay proof push shown in the foreground.
    var onProof: ((String) -> Void)?

    init(center: UNUserNotificationCenter = .current(), handled: HandledPushLog = HandledPushLog()) {
        self.center = center
        self.handled = handled
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
        switch method {
        case "send":
            guard let args, let notification = try? args.decode(as: HobworkNotification.self) else {
                throw CallError(code: "bad_request", message: "notifications.send needs an id and a title")
            }
            return try await send(notification)
        case "withdraw":
            guard let ids = args?["ids"]?.arrayValue?.compactMap(\.stringValue) else {
                throw CallError(code: "bad_request", message: "notifications.withdraw needs ids")
            }
            Self.withdraw(ids, from: center)
            return .object([:])
        default:
            throw CallError(code: "unsupported", message: "Unknown method notifications.\(method)")
        }
    }

    private func send(_ notification: HobworkNotification) async throws -> JSONValue {
        guard await authorizationStatus().allowsNotifications else {
            throw CallError(code: "not_authorized", message: "Notifications are turned off for Hobwork on this device")
        }
        // An update must not bring back a notification someone dismissed.
        if notification.update == true, !(await isShowing(notification.id)) {
            handled.claim(NotificationPayload.handledKey(id: notification.id, revision: notification.revision))
            return .object(["id": .string(notification.id), "shown": .bool(false)])
        }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        if let body = notification.body { content.body = body }
        content.sound = notification.sound == "none" || notification.level == .passive ? nil : .default
        content.interruptionLevel = notification.level
        if let thread = notification.thread ?? notification.project { content.threadIdentifier = thread }
        if let icon = notification.icon { content.icon = URL(string: icon) }
        content.userInfo = [NotificationPayload.userInfoKey: notification.payload.userInfoValue]
        if let category = await NotificationCategories.register(notification.payload) {
            content.categoryIdentifier = category
        }
        do {
            try await center.add(UNNotificationRequest(identifier: notification.id, content: content, trigger: nil))
        } catch {
            throw CallError(code: "failed", message: error.localizedDescription)
        }
        // A push of the same notification, when the host also sent one, is then dropped.
        handled.claim(NotificationPayload.handledKey(id: notification.id, revision: notification.revision))
        return .object(["id": .string(notification.id)])
    }

    private func isShowing(_ id: String) async -> Bool {
        let delivered = await center.deliveredNotifications().map(\.request.identifier)
        return delivered.contains(id)
    }

    /// Removes notifications a hob withdrew, shown or not yet shown.
    nonisolated static func withdraw(_ ids: [String], from center: UNUserNotificationCenter = .current()) {
        guard !ids.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
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
            return Response(event: nil, path: NotificationPayload.link(project: notification.project, open: notification.open))
        default:
            let data: JSONValue = .object(["id": .string(notification.id), "action": .string(actionIdentifier)])
            let action = notification.actions?.first { $0.id == actionIdentifier }
            let path = action?.foreground == true ? NotificationPayload.link(project: notification.project, open: action?.open) : nil
            return Response(event: DeviceEvent(capability: capability, name: "action", data: data), path: path)
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
    // The completion-handler forms, completed on the main actor: UIKit asserts when the
    // response's completion runs off the main thread, which the async forms do when
    // nonisolated.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let content = notification.request.content
        let proof: String? = if case let .proof(nonce)? = RelayPush(userInfo: content.userInfo) { nonce } else { nil }
        let options = proof == nil ? Self.presentation(for: content) : []
        Self.complete(MainCompletion(completionHandler), with: options) {
            if let proof { self.proofArrived(proof) }
        }
    }

    /// The extension marks a push that repeats a notification this device already showed.
    /// The extension cannot hide a notification, but the app can while open. Quiet
    /// notifications and updates stay as quiet in front as they would be in the background.
    nonisolated static func presentation(for content: UNNotificationContent) -> UNNotificationPresentationOptions {
        if content.userInfo[OpenedPush.repeatedKey] != nil { return [] }
        var options: UNNotificationPresentationOptions = content.interruptionLevel == .passive ? [.list] : [.banner, .list]
        if content.sound != nil, content.interruptionLevel != .passive { options.insert(.sound) }
        return options
    }

    private func proofArrived(_ nonce: String) {
        onProof?(nonce)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let result = if let push = CommandPush(userInfo: userInfo) {
            Self.response(to: push, actionIdentifier: response.actionIdentifier)
        } else {
            Self.response(to: NotificationPayload(userInfo: userInfo), actionIdentifier: response.actionIdentifier)
        }
        Self.complete(MainCompletion { _ in completionHandler() }, with: ()) {
            if let result { await self.onResponse?(result) }
        }
    }

    nonisolated static func complete<Value: Sendable>(
        _ completion: MainCompletion<Value>,
        with value: Value,
        after work: @escaping @MainActor @Sendable () async -> Void
    ) {
        Task { @MainActor in
            await work()
            completion.call(value)
        }
    }
}

/// A UserNotifications completion handler, which is not Sendable, called only on the main actor.
struct MainCompletion<Value>: @unchecked Sendable {
    private let handler: (Value) -> Void

    init(_ handler: @escaping (Value) -> Void) { self.handler = handler }

    @MainActor func call(_ value: Value) { handler(value) }
}
