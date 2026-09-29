import CryptoKit
import Foundation
import Security

struct PKCE: Equatable, Sendable {
    let verifier: String
    let challenge: String

    init(verifier: String) {
        self.verifier = verifier
        challenge = Base64URL.encode(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// 32 random bytes give the 43 character verifier RFC 7636 recommends.
    static func random() -> PKCE {
        PKCE(verifier: Base64URL.encode(randomBytes(32)))
    }
}

enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

func randomBytes(_ count: Int) -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
    return Data(bytes)
}
