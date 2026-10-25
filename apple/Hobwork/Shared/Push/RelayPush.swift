import Foundation
import UserNotifications

/// A push from the relay: `hobwork: { v: 1, ... }`.
enum RelayPush: Equatable, Sendable {
    /// Sealed by a host.
    case sealed(grant: String, keyId: String, ciphertext: Data)
    /// The ownership proof for a new APNs token.
    case proof(nonce: String)
    /// Grants the relay asks to renew.
    case renew(grants: [String])

    init?(userInfo: [AnyHashable: Any]) {
        guard let raw = userInfo[NotificationPayload.userInfoKey], let value = JSONValue(foundationValue: raw),
              value["v"]?.numberValue == 1
        else { return nil }
        if let grant = value["grant"]?.stringValue, let keyId = value["keyId"]?.stringValue,
           let ciphertext = value["ciphertext"]?.stringValue.flatMap({ Data(base64Encoded: $0) }) {
            self = .sealed(grant: grant, keyId: keyId, ciphertext: ciphertext)
        } else if let nonce = value["proof"]?.stringValue {
            self = .proof(nonce: nonce)
        } else if let grants = value["renew"]?.arrayValue {
            self = .renew(grants: grants.compactMap(\.stringValue))
        } else {
            return nil
        }
    }
}

/// A sealed push, opened.
struct OpenedPush: Equatable, Sendable {
    /// Set in the `userInfo` of a push the extension dropped as a repeat.
    static let repeatedKey = "hobworkRepeated"

    var host: URL
    var aps: JSONValue
    var hobwork: JSONValue

    /// The notification or command ID, which a repeat would share.
    var handledId: String? {
        if let command = hobwork["command"], let id = command["id"] {
            return DeviceCommand(id: id, capability: "", method: "").key
        }
        guard let id = hobwork["id"]?.stringValue else { return nil }
        return NotificationPayload.handledKey(id: id, revision: hobwork["revision"]?.numberValue.map { Int($0) })
    }

    /// Notification IDs a hob withdrew, from a background push.
    var withdrawn: [String]? {
        hobwork["withdraw"]?.arrayValue?.compactMap(\.stringValue)
    }

    var isCommand: Bool { hobwork["command"] != nil }

    /// What the host would have put in an unsealed push, so `NotificationPayload`,
    /// `CommandPush` and taps work as before.
    var userInfo: [AnyHashable: Any] {
        var info: [AnyHashable: Any] = [:]
        if let aps = aps.propertyListValue { info["aps"] = aps }
        if let hobwork = hobwork.propertyListValue { info[NotificationPayload.userInfoKey] = hobwork }
        return info
    }

    func apply(to content: UNMutableNotificationContent) {
        switch aps["alert"] {
        case let .string(body)?:
            content.title = ""
            content.subtitle = ""
            content.body = body
        case let .object(alert)?:
            content.title = alert["title"]?.stringValue ?? ""
            content.subtitle = alert["subtitle"]?.stringValue ?? ""
            content.body = alert["body"]?.stringValue ?? ""
        default:
            break
        }
        switch aps["sound"] {
        case .string("default")?: content.sound = .default
        case let .string(name)?: content.sound = UNNotificationSound(named: UNNotificationSoundName(name))
        default: content.sound = nil
        }
        content.threadIdentifier = aps["thread-id"]?.stringValue ?? ""
        content.categoryIdentifier = aps["category"]?.stringValue ?? ""
        content.interruptionLevel = switch aps["interruption-level"]?.stringValue {
        case "passive": .passive
        case "time-sensitive": .timeSensitive
        case "critical": .critical
        default: .active
        }
        if let score = aps["relevance-score"]?.numberValue { content.relevanceScore = score }
        if let badge = aps["badge"]?.numberValue { content.badge = NSNumber(value: badge) }
        // Icon comes from the encrypted payload, not the relay's fallback aps.
        content.icon = URL(string: hobwork["icon"]?.stringValue)
        content.userInfo = userInfo
    }
}

/// Opens sealed pushes and drops the ones that do not open, are stale or repeat one
/// this device already handled.
struct PushOpener: Sendable {
    /// How far ahead of this device's clock a push may say it was sent.
    static let clockSkew: TimeInterval = 5 * 60

    enum Drop: Error, Equatable {
        case unknownGrant
        case unknownKey
        case unreadable
        case expired
        case fromTheFuture
        case repeated(String)
    }

    var store = PushStore()
    var handled = HandledPushLog()
    /// Whether a command with this key already ran or is running, over any path.
    var commandSeen: @Sendable (String) -> Bool = { FileCommandLog().contains($0) }

    func open(grant: String, keyId: String, ciphertext: Data, now: Date = .now) throws(Drop) -> OpenedPush {
        guard let pairing = store.pairing(grant: grant), let appKey = pairing.agreementKey else { throw .unknownGrant }
        guard let hostKey = pairing.encryptionKey(for: keyId) else { throw .unknownKey }
        let content: SealedPushContent
        do {
            let plaintext = try PushCrypto.open(ciphertext: ciphertext, grant: grant, appKey: appKey, hostKey: hostKey)
            content = try JSONDecoder().decode(SealedPushContent.self, from: plaintext)
        } catch {
            throw .unreadable
        }
        guard content.v == 1, content.aps.objectValue != nil, content.hobwork.objectValue != nil else { throw .unreadable }
        let seconds = now.timeIntervalSince1970
        if content.expiresAt != 0, Double(content.expiresAt) <= seconds { throw .expired }
        if Double(content.sentAt) > seconds + Self.clockSkew { throw .fromTheFuture }
        let opened = OpenedPush(host: pairing.host, aps: content.aps, hobwork: content.hobwork)
        if let id = opened.handledId {
            if opened.isCommand, commandSeen(id) { throw .repeated(id) }
            guard handled.claim(id, now: now) else { throw .repeated(id) }
        }
        return opened
    }
}

extension JSONValue {
    /// Property list types for `userInfo`, which has no null: nulls are left out.
    var propertyListValue: Any? {
        switch self {
        case .null: nil
        case let .bool(value): value
        case let .number(value): value
        case let .string(value): value
        case let .array(value): value.compactMap(\.propertyListValue)
        case let .object(value): value.compactMapValues(\.propertyListValue)
        }
    }
}
