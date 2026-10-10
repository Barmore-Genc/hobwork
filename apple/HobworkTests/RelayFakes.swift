import Compression
import CryptoKit
import Foundation
@testable import Hobwork

/// An in-memory push relay with the behaviour the app relies on. Proof pushes go
/// straight to `inbox`, as the notification service extension would write them.
final class FakeRelay: RelayTransport, @unchecked Sendable {
    struct Registration {
        var id: String
        var secret: String
        var attested: Bool
        var token: String?
        var pending: (token: String, nonce: String)?
        var gone = false
    }

    struct Grant {
        var id: String
        var registration: String
        var pairing: String
        var publicKey: String
        var expiresAt: Int
    }

    private let lock = NSLock()
    private var _registrations: [String: Registration] = [:]
    private var _grants: [String: Grant] = [:]
    private var _requests: [URLRequest] = []
    private var counter = 0

    var inbox: SharedFile<ProofNotice?>?
    /// Whether proof pushes reach the device.
    var deliversProofs = true
    /// Whether the extension answers the proof itself, as it does without App Attest.
    var extensionConfirms = false
    var now = 1_790_841_600

    var requests: [URLRequest] { lock.withLock { _requests } }
    var registrations: [Registration] { lock.withLock { Array(_registrations.values) } }
    var grants: [Grant] { lock.withLock { Array(_grants.values) } }

    func requests(_ method: String, _ suffix: String) -> [URLRequest] {
        requests.filter { $0.httpMethod == method && ($0.url?.path ?? "").hasSuffix(suffix) }
    }

    /// APNs reported the token gone.
    func dropToken(of id: String) {
        lock.withLock {
            _registrations[id]?.token = nil
            _registrations[id]?.gone = true
        }
    }

    func forget(registration id: String) {
        lock.withLock { _ = _registrations.removeValue(forKey: id) }
    }

    func setExpiry(_ expiresAt: Int, grant: String) {
        lock.withLock { _grants[grant]?.expiresAt = expiresAt }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body, proof) = lock.withLock { handle(request) }
        if let (registration, nonce) = proof { deliverProof(nonce, registration: registration) }
        let data = try JSONEncoder().encode(body)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    private func deliverProof(_ nonce: String, registration: String) {
        guard deliversProofs, let inbox else { return }
        var confirmed = false
        if extensionConfirms {
            confirmed = lock.withLock { confirm(registration, nonce: nonce) }
        }
        inbox.update { $0 = ProofNotice(nonce: nonce, receivedAt: .now, confirmed: confirmed) }
    }

    private func next(_ prefix: String) -> String {
        counter += 1
        return "\(prefix)\(counter)"
    }

    private func error(_ status: Int, _ code: String) -> (Int, JSONValue, (String, String)?) {
        (status, .object(["error": .string(code), "message": .string(code)]), nil)
    }

    private func confirm(_ id: String, nonce: String) -> Bool {
        guard var registration = _registrations[id], let pending = registration.pending, pending.nonce == nonce else { return false }
        if registration.gone {
            _grants = _grants.filter { $0.value.registration != id }
        }
        registration.token = pending.token
        registration.pending = nil
        registration.gone = false
        _registrations[id] = registration
        return true
    }

    private func status(_ registration: Registration) -> String {
        registration.token != nil ? "active" : registration.gone ? "gone" : "pending"
    }

    private func handle(_ request: URLRequest) -> (Int, JSONValue, (String, String)?) {
        _requests.append(request)
        let method = request.httpMethod ?? "GET"
        let parts = (request.url?.path ?? "").split(separator: "/").map(String.init)
        let body = request.httpBody.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
        if method == "POST", parts == ["v1", "attest", "challenges"] {
            return (201, .object(["challenge": .string(next("challenge"))]), nil)
        }
        if method == "POST", parts == ["v1", "registrations"] {
            guard let token = body["token"]?.stringValue else { return error(400, "bad_request") }
            let id = next("reg")
            let nonce = next("nonce")
            _registrations[id] = Registration(
                id: id, secret: "secret-\(id)", attested: body["attestation"] != nil, token: nil, pending: (token, nonce)
            )
            return (201, .object(["id": .string(id), "secret": .string("secret-\(id)"), "status": .string("pending")]), (id, nonce))
        }
        guard parts.count >= 3, parts[0] == "v1", parts[1] == "registrations", var registration = _registrations[parts[2]],
              request.value(forHTTPHeaderField: "Authorization") == "Bearer \(registration.secret)"
        else { return error(401, "unauthorized") }
        if registration.attested, request.value(forHTTPHeaderField: "Hobwork-Assertion") == nil {
            return error(401, "assertion_required")
        }
        let id = registration.id
        switch (method, Array(parts.dropFirst(3))) {
        case ("GET", []):
            let grants = _grants.values.filter { $0.registration == id }.sorted { $0.id < $1.id }.map {
                JSONValue.object(["id": .string($0.id), "pairing": .string($0.pairing), "expiresAt": .number(Double($0.expiresAt))])
            }
            return (200, .object([
                "id": .string(id), "status": .string(status(registration)), "attested": .bool(registration.attested),
                "grants": .array(grants),
            ]), nil)
        case ("PUT", []):
            guard let token = body["token"]?.stringValue else { return error(400, "bad_request") }
            if registration.token == token { return (200, .object(["status": .string("active")]), nil) }
            let nonce = next("nonce")
            registration.pending = (token, nonce)
            _registrations[id] = registration
            return (202, .object(["status": .string("pending")]), (id, nonce))
        case ("DELETE", []):
            _registrations[id] = nil
            _grants = _grants.filter { $0.value.registration != id }
            return (204, .null, nil)
        case ("POST", ["proof"]):
            guard let nonce = body["nonce"]?.stringValue, confirm(id, nonce: nonce) else { return error(400, "bad_nonce") }
            return (200, .object(["status": .string("active")]), nil)
        case ("POST", ["proof-push"]):
            guard let pending = registration.pending else { return error(409, "nothing_pending") }
            let nonce = next("nonce")
            registration.pending = (pending.token, nonce)
            _registrations[id] = registration
            return (204, .null, (id, nonce))
        case ("POST", ["grants"]):
            guard registration.token != nil else { return error(409, "not_active") }
            guard let pairing = body["pairing"]?.stringValue, let key = body["publicKey"]?.stringValue else { return error(400, "bad_request") }
            _grants = _grants.filter { !($0.value.registration == id && $0.value.pairing == pairing) }
            let grant = Grant(id: next("grant"), registration: id, pairing: pairing, publicKey: key, expiresAt: now + 30 * 86400)
            _grants[grant.id] = grant
            return (201, .object(["id": .string(grant.id), "expiresAt": .number(Double(grant.expiresAt))]), nil)
        case let ("POST", path) where path.count == 3 && path[0] == "grants" && path[2] == "renew":
            guard var grant = _grants[path[1]], grant.registration == id else { return error(404, "unknown_grant") }
            if registration.token == nil { return error(410, "gone") }
            if grant.expiresAt <= now { return error(410, "expired") }
            grant.expiresAt = now + 30 * 86400
            _grants[grant.id] = grant
            return (200, .object(["expiresAt": .number(Double(grant.expiresAt))]), nil)
        case let ("DELETE", path) where path.count == 2 && path[0] == "grants":
            guard _grants[path[1]]?.registration == id else { return error(404, "unknown_grant") }
            _grants[path[1]] = nil
            return (204, .null, nil)
        default:
            return error(404, "not_found")
        }
    }
}

/// App Attest stand-in: assertions are the client data hash, so tests can check what was signed.
final class FakeAttest: AppAttesting, @unchecked Sendable {
    private let lock = NSLock()
    private var _hashes: [Data] = []
    private var inFlight = 0
    private(set) var overlapped = false
    var isSupported = true
    var delay: Duration = .zero

    var hashes: [Data] { lock.withLock { _hashes } }

    func generateKey() async throws -> String { "a2V5LWlk" }

    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data { Data("attestation".utf8) + clientDataHash }

    func assertion(keyId: String, clientDataHash: Data) async throws -> Data {
        lock.withLock {
            inFlight += 1
            if inFlight > 1 { overlapped = true }
        }
        try await Task.sleep(for: delay)
        lock.withLock {
            inFlight -= 1
            _hashes.append(clientDataHash)
        }
        return clientDataHash
    }
}

/// A transport that records requests, answers 200 `{}` and tracks overlapping sends.
final class RecordingTransport: RelayTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    var answer: JSONValue = .object([:])
    var status = 200
    var delay: Duration = .zero

    var requests: [URLRequest] { lock.withLock { _requests } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await Task.sleep(for: delay)
        lock.withLock { _requests.append(request) }
        return (try JSONEncoder().encode(answer), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

/// Seals a plaintext the way the host does.
enum TestSealer {
    static func deflate(_ data: Data) -> Data {
        let capacity = data.count + 1024
        var output = Data(count: capacity)
        let written = output.withUnsafeMutableBytes { out in
            data.withUnsafeBytes { input in
                compression_encode_buffer(
                    out.bindMemory(to: UInt8.self).baseAddress!, capacity,
                    input.bindMemory(to: UInt8.self).baseAddress!, data.count,
                    nil, COMPRESSION_ZLIB
                )
            }
        }
        return output.prefix(written)
    }

    static func frame(_ compressed: Data) -> Data {
        let count = UInt32(compressed.count)
        var framed = Data([UInt8(count >> 24), UInt8(count >> 16 & 0xFF), UInt8(count >> 8 & 0xFF), UInt8(count & 0xFF)])
        framed += compressed
        let padded = (framed.count + 255) / 256 * 256
        framed += Data(count: padded - framed.count)
        return framed
    }

    static func seal(
        _ plaintext: Data,
        grant: String,
        hostKey: Curve25519.KeyAgreement.PrivateKey,
        appKey: Curve25519.KeyAgreement.PublicKey
    ) throws -> Data {
        let secret = try hostKey.sharedSecretFromKeyAgreement(with: appKey)
        let key = secret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: appKey.rawRepresentation + hostKey.publicKey.rawRepresentation,
            sharedInfo: Data("hobwork-push-v1".utf8),
            outputByteCount: 32
        )
        return try ChaChaPoly.seal(frame(deflate(plaintext)), using: key, authenticating: Data(grant.utf8)).combined
    }
}
