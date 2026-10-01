import CryptoKit
import Foundation
import Security

/// The push keys a host sends at pairing and after every `hello`.
struct HostPushKeys: Codable, Equatable, Sendable {
    var relay: String
    /// Ed25519, raw 32 bytes in standard base64.
    var signingKey: String
    /// X25519, raw 32 bytes in standard base64.
    var encryptionKey: String
    var keyId: String
}

/// What the host gets in `hello` and `PUT /api/devices/push`: the grant ID and this
/// pairing's X25519 public key.
struct HostPushGrant: Codable, Equatable, Sendable {
    var grant: String
    var key: String
}

/// This device's single registration with the relay, for all pairings.
struct StoredRelayRegistration: Codable, Equatable, Sendable {
    var id: String
    var secret: String
    /// Set for a registration App Attest vouched for.
    var attestKeyId: String?
    /// The APNs token last sent, in hex.
    var token: String
    var environment: PushEnvironment
    var status: RelayRegistrationStatus

    var auth: RelayAuth {
        RelayAuth(id: id, secret: secret, attestKeyId: attestKeyId)
    }
}

/// Push state for one pairing with a host.
struct PushPairing: Codable, Equatable, Sendable {
    struct Grant: Codable, Equatable, Sendable {
        var id: String
        var expiresAt: Date
        /// The host signing key the grant is for.
        var signingKey: String
    }

    var host: URL
    /// Random, so it says nothing about the host.
    var pairingId: String
    /// X25519, raw.
    var privateKey: Data
    var keys: HostPushKeys
    /// Encryption keys the host used before, by key ID, so pushes in flight while it
    /// changes keys still open.
    var previousKeys: [String: String] = [:]
    var grant: Grant?

    init(host: URL, keys: HostPushKeys) {
        self.host = host
        pairingId = Base64URL.encode(randomBytes(16))
        privateKey = Curve25519.KeyAgreement.PrivateKey().rawRepresentation
        self.keys = keys
    }

    var agreementKey: Curve25519.KeyAgreement.PrivateKey? {
        try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
    }

    /// The app's public key for this pairing, as the host gets it.
    var appKey: String {
        agreementKey?.publicKey.rawRepresentation.base64EncodedString() ?? ""
    }

    var hostGrant: HostPushGrant? {
        grant.map { HostPushGrant(grant: $0.id, key: appKey) }
    }

    func encryptionKey(for keyId: String) -> Data? {
        let key = keyId == keys.keyId ? keys.encryptionKey : previousKeys[keyId]
        return key.flatMap { Data(base64Encoded: $0) }
    }

    /// Takes keys the host sent. Returns whether the signing key changed, which needs a new grant.
    mutating func update(_ new: HostPushKeys) -> Bool {
        guard new != keys else { return false }
        if new.keyId != keys.keyId {
            previousKeys = [keys.keyId: keys.encryptionKey]
        }
        let signingChanged = new.signingKey != keys.signingKey
        keys = new
        return signingChanged
    }
}

/// Keychain items of one service, behind a protocol so tests keep them in memory.
protocol SecretItems: Sendable {
    func load(_ account: String) -> Data?
    func save(_ data: Data, account: String) throws
    func delete(_ account: String)
    func all() -> [(account: String, data: Data)]
}

struct KeychainItems: SecretItems {
    var service: String
    var accessGroup: String? = AppGroup.identifier

    func load(_ account: String) -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    func save(_ data: Data, account: String) throws {
        delete(account)
        var query = baseQuery(account: account)
        query[kSecValueData as String] = data
        // Pushes are opened while the phone is locked.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func delete(_ account: String) {
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }

    func all() -> [(account: String, data: Data)] {
        var query = baseQuery(account: nil)
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]]
        else { return [] }
        return items.compactMap { item in
            guard let account = item[kSecAttrAccount as String] as? String, let data = item[kSecValueData as String] as? Data else { return nil }
            return (account, data)
        }
    }

    private func baseQuery(account: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let account { query[kSecAttrAccount as String] = account }
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

final class MemoryItems: SecretItems, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    func load(_ account: String) -> Data? { lock.withLock { items[account] } }
    func save(_ data: Data, account: String) throws { lock.withLock { items[account] = data } }
    func delete(_ account: String) { lock.withLock { _ = items.removeValue(forKey: account) } }
    func all() -> [(account: String, data: Data)] { lock.withLock { items.map { ($0.key, $0.value) } } }
}

/// The relay registration and the push state of each pairing, in the Keychain under the
/// app group's access group, since the notification service extension opens pushes
/// with the pairing keys.
struct PushStore: Sendable {
    private static let registrationAccount = "registration"
    private static let pairingPrefix = "pairing:"

    var items: any SecretItems = KeychainItems(service: "dev.bgenc.hobwork.push")

    func registration() -> StoredRelayRegistration? {
        items.load(Self.registrationAccount).flatMap { try? JSONDecoder().decode(StoredRelayRegistration.self, from: $0) }
    }

    func save(_ registration: StoredRelayRegistration) throws {
        try items.save(JSONEncoder().encode(registration), account: Self.registrationAccount)
    }

    func removeRegistration() {
        items.delete(Self.registrationAccount)
    }

    func pairing(for host: URL) -> PushPairing? {
        items.load(Self.pairingPrefix + host.absoluteString).flatMap { try? JSONDecoder().decode(PushPairing.self, from: $0) }
    }

    func pairings() -> [PushPairing] {
        items.all()
            .filter { $0.account.hasPrefix(Self.pairingPrefix) }
            .compactMap { try? JSONDecoder().decode(PushPairing.self, from: $0.data) }
            .sorted { $0.host.absoluteString < $1.host.absoluteString }
    }

    func pairing(grant: String) -> PushPairing? {
        pairings().first { $0.grant?.id == grant }
    }

    func save(_ pairing: PushPairing) throws {
        try items.save(JSONEncoder().encode(pairing), account: Self.pairingPrefix + pairing.host.absoluteString)
    }

    func removePairing(for host: URL) {
        items.delete(Self.pairingPrefix + host.absoluteString)
    }
}

/// The nonce of the last ownership proof push, which the extension writes and the app
/// sends when the extension could not.
struct ProofNotice: Codable, Equatable, Sendable {
    var nonce: String
    var receivedAt: Date
    /// The extension already sent it and the relay took it.
    var confirmed = false
}

enum ProofInbox {
    static let file = SharedFile<ProofNotice?>(name: "relay-proof.json", empty: nil)
}

/// IDs of notifications and commands this device already handled, so a push repeating
/// one is dropped.
struct HandledPushLog: Sendable {
    /// APNs keeps a push at most a day by default; commands expire after 10 minutes.
    static let retention: TimeInterval = 24 * 60 * 60

    let file: SharedFile<[String: Date]>

    init(file: SharedFile<[String: Date]> = SharedFile(name: "handled-pushes.json", empty: [:])) {
        self.file = file
    }

    /// Records the ID and returns whether it was new.
    @discardableResult
    func claim(_ id: String, now: Date = .now) -> Bool {
        file.update { entries in
            entries = entries.filter { now.timeIntervalSince($0.value) < Self.retention }
            guard entries[id] == nil else { return false }
            entries[id] = now
            return true
        }
    }

    func contains(_ id: String) -> Bool {
        file.read()[id] != nil
    }
}
