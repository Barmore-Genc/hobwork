import DeviceCheck
import Foundation

/// App Attest, behind a protocol so tests can stand in for it.
protocol AppAttesting: RelayAsserter {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data
}

struct SystemAppAttest: AppAttesting {
    var isSupported: Bool { DCAppAttestService.shared.isSupported }

    func generateKey() async throws -> String {
        try await DCAppAttestService.shared.generateKey()
    }

    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        try await DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash)
    }

    func assertion(keyId: String, clientDataHash: Data) async throws -> Data {
        try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash)
    }

    /// The key is gone or unusable, so its registration can never be used again.
    static func isLostKey(_ error: Error) -> Bool {
        (error as? DCError)?.code == .invalidKey
    }

    static func isUnsupported(_ error: Error) -> Bool {
        (error as? DCError)?.code == .featureUnsupported
    }
}
