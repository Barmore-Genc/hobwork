import UserNotifications

/// Opens sealed relay pushes, answers the relay's proof and renewal pushes, runs commands
/// from command pushes and registers the category a notification push names
/// (`aps.category`, `hobwork.<id>`) from the actions in its `hobwork` key. Categories have
/// to exist before iOS shows a notification, and every notification can have its own actions.
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
        switch RelayPush(userInfo: request.content.userInfo) {
        case let .sealed(grant, keyId, ciphertext):
            do {
                let opened = try PushOpener().open(grant: grant, keyId: keyId, ciphertext: ciphertext)
                opened.apply(to: content)
                handle(content, host: opened.host, pending: pending)
            } catch let .repeated(id) {
                content.userInfo[OpenedPush.repeatedKey] = id
                deliver(content)
            } catch {
                // Without the filtering entitlement the relay's own text shows.
                deliver(request.content)
            }
        case let .proof(nonce):
            Task {
                let (service, content) = pending.value
                await RelayExtension.answerProof(nonce)
                service.deliver(content)
            }
        case let .renew(grants):
            Task {
                let (service, content) = pending.value
                await RelayExtension.renew(grants)
                service.deliver(content)
            }
        case nil:
            handle(content, host: nil, pending: pending)
        }
    }

    private func handle(_ content: UNMutableNotificationContent, host: URL?, pending: UncheckedSendable<(NotificationService, UNMutableNotificationContent)>) {
        if let push = CommandPush(userInfo: content.userInfo), !push.command.foreground {
            Task { @MainActor in
                let (service, content) = pending.value
                if let summary = await CommandPushHandler.run(push.command, host: host) { content.body = summary }
                service.deliver(content)
            }
            return
        }
        guard let payload = NotificationPayload(userInfo: content.userInfo), payload.actions?.isEmpty == false else {
            deliver(content)
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

    /// Shows the push as it came: for a command, the text that says to open Hobwork if the
    /// change did not apply.
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
    static func run(_ command: DeviceCommand, host: URL?) async -> String? {
        guard let pairing = StoredPairing.load(), host == nil || host == pairing.host else { return nil }
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

/// Relay calls the extension makes. App Attest keys belong to the app's bundle ID, so for
/// an attested registration the extension only leaves the nonce for the app.
enum RelayExtension {
    /// Sends the nonce first, so the app does not send it too while waiting.
    static func answerProof(_ nonce: String) async {
        let store = PushStore()
        var confirmed = false
        if var registration = store.registration(), registration.attestKeyId == nil,
           (try? await RelayClient().proof(registration.auth, nonce: nonce)) == .active {
            registration.status = .active
            try? store.save(registration)
            confirmed = true
        }
        ProofInbox.file.update { $0 = ProofNotice(nonce: nonce, receivedAt: .now, confirmed: confirmed) }
    }

    static func renew(_ grants: [String]) async {
        let store = PushStore()
        guard let registration = store.registration(), registration.attestKeyId == nil else { return }
        for var pairing in store.pairings() {
            guard let grant = pairing.grant, grants.contains(grant.id),
                  let expiresAt = try? await RelayClient().renewGrant(registration.auth, grant: grant.id)
            else { continue }
            pairing.grant?.expiresAt = Date(timeIntervalSince1970: TimeInterval(expiresAt))
            try? store.save(pairing)
        }
    }
}

/// The extension gets non-Sendable values from UserNotifications and hands them to one task.
private struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
