import ActivityKit
import Foundation

/// A hob's Live Activity. The relay names this type in `attributes-type` of push-to-start
/// pushes, so it keeps its name.
///
/// Pushes from the relay carry the attributes and the state sealed as `{ "hobwork": <envelope> }`;
/// decoding opens them with the pairing's keys. Encoding always writes the plain fields.
struct HobworkActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        struct Action: Codable, Hashable, Sendable {
            var title: String
            var opensApp: Bool?
        }

        var title: String
        var subtitle: String?
        /// `#RRGGBB`.
        var swatches: [String]?
        /// An SF Symbol name.
        var icon: String?
        var tint: String?
        /// Unix seconds, so the value does not depend on the encoder's date strategy.
        var endsAt: Double?
        var startedAt: Double?
        /// 0...1, in place of the bar from `startedAt` to `endsAt`.
        var progress: Double?
        /// Shown large in place of the countdown.
        var value: String?
        var valueLabel: String?
        var button: Action?
        /// A path of the hob's UI.
        var open: String?
        /// The activity outlived what iOS keeps it updating for.
        var stillRunning: Bool?

        init(
            title: String, subtitle: String? = nil, swatches: [String]? = nil, icon: String? = nil, tint: String? = nil,
            endsAt: Double? = nil, startedAt: Double? = nil, progress: Double? = nil, value: String? = nil,
            valueLabel: String? = nil, button: Action? = nil, open: String? = nil, stillRunning: Bool? = nil
        ) {
            self.title = title
            self.subtitle = subtitle
            self.swatches = swatches
            self.icon = icon
            self.tint = tint
            self.endsAt = endsAt
            self.startedAt = startedAt
            self.progress = progress
            self.value = value
            self.valueLabel = valueLabel
            self.button = button
            self.open = open
            self.stillRunning = stillRunning
        }

        static let placeholder = ContentState(title: "Hobwork", subtitle: "Open Hobwork to see this.")

        var endDate: Date? { endsAt.map { Date(timeIntervalSince1970: $0) } }
        var startDate: Date? { startedAt.map { Date(timeIntervalSince1970: $0) } }
    }

    var hob: String
    var id: String
}

extension HobworkActivityAttributes {
    private enum Keys: String, CodingKey {
        case hob, id, hobwork
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if container.contains(.hobwork) {
            let sealed = (try? container.decode(JSONValue.self, forKey: .hobwork)).flatMap { SealedLiveActivity.open($0, store: decoder.pushStore) }
            self.init(hob: sealed?.hob ?? "", id: sealed?.id ?? "")
            return
        }
        try self.init(hob: container.decode(String.self, forKey: .hob), id: container.decode(String.self, forKey: .id))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(hob, forKey: .hob)
        try container.encode(id, forKey: .id)
    }
}

extension HobworkActivityAttributes.ContentState {
    private enum SealedKeys: String, CodingKey {
        case hobwork
    }

    /// A sealed state that does not open becomes the placeholder: ActivityKit decodes the
    /// same state many times, and a throw would leave the activity blank.
    init(from decoder: Decoder) throws {
        if try decoder.container(keyedBy: SealedKeys.self).contains(.hobwork) {
            let envelope = try? decoder.container(keyedBy: SealedKeys.self).decode(JSONValue.self, forKey: .hobwork)
            let state = envelope.flatMap { SealedLiveActivity.open($0, store: decoder.pushStore) }?.state
            self = state.flatMap { try? JSONDecoder().decode(Self.self, from: JSONEncoder().encode($0)) } ?? .placeholder
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            title: container.decode(String.self, forKey: .title),
            subtitle: container.decodeIfPresent(String.self, forKey: .subtitle),
            swatches: container.decodeIfPresent([String].self, forKey: .swatches),
            icon: container.decodeIfPresent(String.self, forKey: .icon),
            tint: container.decodeIfPresent(String.self, forKey: .tint),
            endsAt: container.decodeIfPresent(Double.self, forKey: .endsAt),
            startedAt: container.decodeIfPresent(Double.self, forKey: .startedAt),
            progress: container.decodeIfPresent(Double.self, forKey: .progress),
            value: container.decodeIfPresent(String.self, forKey: .value),
            valueLabel: container.decodeIfPresent(String.self, forKey: .valueLabel),
            button: container.decodeIfPresent(Action.self, forKey: .button),
            open: container.decodeIfPresent(String.self, forKey: .open),
            stillRunning: container.decodeIfPresent(Bool.self, forKey: .stillRunning)
        )
    }
}

/// `hobwork.liveActivity` of a sealed Live Activity push.
struct SealedLiveActivity: Equatable, Sendable {
    var hob: String
    var id: String
    var state: JSONValue?

    /// Opens `{ v: 1, grant, keyId, ciphertext }`. Unlike notifications there is no expiry or
    /// repeat check: ActivityKit decodes the same state many times, hours after it arrived.
    static func open(_ envelope: JSONValue, store: PushStore) -> SealedLiveActivity? {
        guard envelope["v"]?.numberValue == 1,
              let grant = envelope["grant"]?.stringValue,
              let keyId = envelope["keyId"]?.stringValue,
              let ciphertext = envelope["ciphertext"]?.stringValue.flatMap({ Data(base64Encoded: $0) }),
              let pairing = store.pairing(grant: grant),
              let appKey = pairing.agreementKey,
              let hostKey = pairing.encryptionKey(for: keyId),
              let plaintext = try? PushCrypto.open(ciphertext: ciphertext, grant: grant, appKey: appKey, hostKey: hostKey),
              let content = try? JSONDecoder().decode(SealedPushContent.self, from: plaintext),
              content.v == 1,
              let activity = content.hobwork["liveActivity"],
              let hob = activity["hob"]?.stringValue,
              let id = activity["id"]?.stringValue
        else { return nil }
        return SealedLiveActivity(hob: hob, id: id, state: activity["state"])
    }
}

extension CodingUserInfoKey {
    /// A `PushStore` for opening sealed Live Activity content, for tests.
    static let pushStore = CodingUserInfoKey(rawValue: "dev.bgenc.hobwork.pushStore")!
}

private extension Decoder {
    var pushStore: PushStore {
        userInfo[.pushStore] as? PushStore ?? PushStore()
    }
}
