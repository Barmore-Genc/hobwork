import Foundation
import Security

/// Device credentials in the Keychain, one item per host.
enum Keychain {
    private static let service = "dev.bgenc.hobwork.device"

    static func save(_ credentials: DeviceCredentials, for host: URL) throws {
        let data = try JSONEncoder().encode(credentials)
        delete(for: host)
        var query = baseQuery(for: host)
        query[kSecValueData as String] = data
        // Notification actions can run while the phone is locked.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    static func load(for host: URL) -> DeviceCredentials? {
        var query = baseQuery(for: host)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(DeviceCredentials.self, from: data)
    }

    static func delete(for host: URL) {
        SecItemDelete(baseQuery(for: host) as CFDictionary)
    }

    private static func baseQuery(for host: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: host.absoluteString,
        ]
    }
}

struct KeychainError: Error, LocalizedError {
    var status: OSStatus

    var errorDescription: String? {
        "Could not save to the Keychain (\(SecCopyErrorMessageString(status, nil) as String? ?? "\(status)"))."
    }
}
