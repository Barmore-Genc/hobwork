import Foundation
import Security

/// Device credentials in the Keychain, one item per host, in the app group's access group
/// so the extensions can answer the host too.
enum Keychain {
    private static let service = "dev.bgenc.hobwork.device"

    static func save(_ credentials: DeviceCredentials, for host: URL, accessGroup: String? = AppGroup.identifier) throws {
        let data = try JSONEncoder().encode(credentials)
        delete(for: host)
        var query = baseQuery(for: host, accessGroup: accessGroup)
        query[kSecValueData as String] = data
        // Notification actions and commands from pushes run while the phone is locked.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(query as CFDictionary, nil)
        #if os(macOS)
            if status == errSecMissingEntitlement {
                var fallback = fileKeychainQuery(for: host)
                fallback[kSecValueData as String] = data
                status = SecItemAdd(fallback as CFDictionary, nil)
            }
        #endif
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    /// Items saved before the app group existed are in the app's own access group. The
    /// first load moves them to the shared one.
    static func load(for host: URL, accessGroup: String? = AppGroup.identifier) -> DeviceCredentials? {
        if let credentials = find(baseQuery(for: host, accessGroup: accessGroup)) { return credentials }
        if let accessGroup, let old = find(baseQuery(for: host, accessGroup: nil)) {
            do {
                try save(old, for: host, accessGroup: accessGroup)
            } catch {
                // Keep using the old item; the next launch tries again.
            }
            return old
        }
        #if os(macOS)
            return find(fileKeychainQuery(for: host))
        #else
            return nil
        #endif
    }

    /// Deletes the item in every access group this process can see.
    static func delete(for host: URL) {
        SecItemDelete(baseQuery(for: host, accessGroup: nil) as CFDictionary)
        #if os(macOS)
            SecItemDelete(fileKeychainQuery(for: host) as CFDictionary)
        #endif
    }

    private static func find(_ query: [String: Any]) -> DeviceCredentials? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(DeviceCredentials.self, from: data)
    }

    private static func baseQuery(for host: URL, accessGroup: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: host.absoluteString,
            // The macOS file-based keychain has no access groups, so the notification
            // service extension could not read the item.
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    #if os(macOS)
        /// Builds signed without a provisioning profile (`just run-mac local`) may not use the
        /// data protection keychain. Only the app reads the item then, which is enough for
        /// a build that gets no pushes.
        private static func fileKeychainQuery(for host: URL) -> [String: Any] {
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: host.absoluteString,
            ]
        }
    #endif
}

struct KeychainError: Error, LocalizedError {
    var status: OSStatus

    var errorDescription: String? {
        "Could not save to the Keychain (\(SecCopyErrorMessageString(status, nil) as String? ?? "\(status)"))."
    }
}

/// The host this device is paired with and its credentials, readable by the extensions.
enum StoredPairing {
    private static let hostKey = "host"

    static func load() -> (host: URL, credentials: DeviceCredentials)? {
        migrateHost()
        guard let host = AppGroup.defaults.url(forKey: hostKey), let credentials = Keychain.load(for: host) else { return nil }
        return (host, credentials)
    }

    static var host: URL? {
        AppGroup.defaults.url(forKey: hostKey)
    }

    static func save(host: URL, credentials: DeviceCredentials) throws {
        try Keychain.save(credentials, for: host)
        AppGroup.defaults.set(host, forKey: hostKey)
    }

    static func remove() {
        if let host = AppGroup.defaults.url(forKey: hostKey) { Keychain.delete(for: host) }
        AppGroup.defaults.removeObject(forKey: hostKey)
        UserDefaults.standard.removeObject(forKey: hostKey)
    }

    /// Earlier versions kept the host in the app's own defaults.
    private static func migrateHost() {
        let group = AppGroup.defaults
        guard group !== UserDefaults.standard, group.url(forKey: hostKey) == nil,
              let host = UserDefaults.standard.url(forKey: hostKey)
        else { return }
        group.set(host, forKey: hostKey)
        UserDefaults.standard.removeObject(forKey: hostKey)
    }
}
