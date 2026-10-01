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
