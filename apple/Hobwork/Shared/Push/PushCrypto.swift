import Compression
import CryptoKit
import Foundation

/// Opens pushes sealed by a host ("Sealing" under "Hosts and apps on the relay" in
/// `docs/architecture.md`).
enum PushCrypto {
    static let info = Data("hobwork-push-v1".utf8)
    /// Padded plaintext is at most what fits in a 4 KB push; anything inflating far past
    /// that is not from a host.
    static let maxPlaintext = 64 * 1024

    enum Failure: Error, Equatable {
        case badKey
        case badCiphertext
        case badFraming
        case badCompression
    }

    /// base64url without padding of the first 8 bytes of SHA-256 of the raw key.
    static func keyId(of publicKey: Data) -> String {
        Base64URL.encode(Data(SHA256.hash(data: publicKey).prefix(8)))
    }

    static func contentKey(appKey: Curve25519.KeyAgreement.PrivateKey, hostKey: Data) throws(Failure) -> SymmetricKey {
        let secret = try sharedSecret(appKey: appKey, hostKey: hostKey)
        return secret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: appKey.publicKey.rawRepresentation + hostKey,
            sharedInfo: info,
            outputByteCount: 32
        )
    }

    static func sharedSecret(appKey: Curve25519.KeyAgreement.PrivateKey, hostKey: Data) throws(Failure) -> SharedSecret {
        do {
            let host = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: hostKey)
            return try appKey.sharedSecretFromKeyAgreement(with: host)
        } catch {
            throw .badKey
        }
    }

    /// The JSON plaintext of a sealed push.
    static func open(ciphertext: Data, grant: String, appKey: Curve25519.KeyAgreement.PrivateKey, hostKey: Data) throws(Failure) -> Data {
        let key = try contentKey(appKey: appKey, hostKey: hostKey)
        let framed: Data
        do {
            let box = try ChaChaPoly.SealedBox(combined: ciphertext)
            framed = try ChaChaPoly.open(box, using: key, authenticating: Data(grant.utf8))
        } catch {
            throw .badCiphertext
        }
        return try inflate(try unframe(framed))
    }

    /// A 4-byte big-endian length, the compressed bytes, then zero padding.
    static func unframe(_ framed: Data) throws(Failure) -> Data {
        let bytes = [UInt8](framed)
        guard bytes.count >= 4 else { throw .badFraming }
        let length = Int(bytes[0]) << 24 | Int(bytes[1]) << 16 | Int(bytes[2]) << 8 | Int(bytes[3])
        guard length <= bytes.count - 4 else { throw .badFraming }
        return Data(bytes[4 ..< 4 + length])
    }

    /// Raw deflate (RFC 1951), which is what `COMPRESSION_ZLIB` reads.
    static func inflate(_ compressed: Data) throws(Failure) -> Data {
        guard !compressed.isEmpty else { throw .badCompression }
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw .badCompression
        }
        defer { compression_stream_destroy(stream) }
        let chunk = 4096
        let output = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { output.deallocate() }
        var result = Data()
        let status: compression_status = compressed.withUnsafeBytes { input in
            stream.pointee.src_ptr = input.bindMemory(to: UInt8.self).baseAddress!
            stream.pointee.src_size = input.count
            while true {
                stream.pointee.dst_ptr = output
                stream.pointee.dst_size = chunk
                let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                result.append(output, count: chunk - stream.pointee.dst_size)
                if status != COMPRESSION_STATUS_OK || result.count > maxPlaintext { return status }
            }
        }
        guard status == COMPRESSION_STATUS_END, result.count <= maxPlaintext else { throw .badCompression }
        return result
    }
}

/// The sealed plaintext: `{ v: 1, sentAt, expiresAt, aps, hobwork }`.
struct SealedPushContent: Decodable, Equatable, Sendable {
    var v: Int
    var sentAt: Int
    /// 0 for none.
    var expiresAt: Int
    var aps: JSONValue
    var hobwork: JSONValue
}
