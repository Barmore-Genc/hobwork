import CryptoKit
import Foundation

enum PushEnvironment: String, Codable, Sendable {
    case sandbox
    case production

    static var current: PushEnvironment {
        #if DEBUG
            .sandbox
        #else
            .production
        #endif
    }
}

/// A relay registration's credentials. `attestKeyId` is set when App Attest vouched for
/// it, and then every request needs an assertion by that key.
struct RelayAuth: Equatable, Sendable {
    var id: String
    var secret: String
    var attestKeyId: String?
}

enum RelayError: Error, Equatable, LocalizedError {
    /// The relay answered `{ error, message }` with this status.
    case refused(status: Int, code: String, message: String?)
    case unreachable(String)
    case invalidResponse
    /// An attested registration, from a process that cannot make assertions for its key.
    case assertionUnavailable

    var code: String? {
        if case let .refused(_, code, _) = self { return code }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case let .refused(status, code, message): message ?? "The push relay answered \(status) \(code)."
        case let .unreachable(reason): reason
        case .invalidResponse: "The push relay sent an answer this app does not understand."
        case .assertionUnavailable: "This process cannot sign requests for the App Attest key."
        }
    }
}

protocol RelayTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: RelayTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RelayError.invalidResponse }
        return (data, http)
    }
}

/// Makes App Attest assertions for the relay's `Hobwork-Assertion` header.
protocol RelayAsserter: Sendable {
    func assertion(keyId: String, clientDataHash: Data) async throws -> Data
}

/// Runs one operation at a time, in order of arrival.
actor SerialGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func run<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
        if busy {
            await withCheckedContinuation { waiters.append($0) }
        }
        busy = true
        defer {
            if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
        }
        return try await body()
    }
}

struct RelayRegistrationCreated: Decodable, Equatable, Sendable {
    var id: String
    var secret: String
    var status: RelayRegistrationStatus
}

enum RelayRegistrationStatus: String, Codable, Sendable {
    case pending
    case active
    case gone
}

struct RelayGrantInfo: Codable, Equatable, Sendable {
    var id: String
    var pairing: String?
    /// Unix seconds.
    var expiresAt: Int
}

struct RelayRegistrationInfo: Decodable, Equatable, Sendable {
    var id: String
    var status: RelayRegistrationStatus
    var attested: Bool
    var grants: [RelayGrantInfo]
}

struct RelayAttestation: Encodable, Equatable, Sendable {
    /// Standard base64, as `DCAppAttestService` returns it.
    var keyId: String
    var object: String
    var challenge: String
}

/// The push relay's app endpoints ("Push relay" in `docs/architecture.md`).
struct RelayClient: Sendable {
    static let builtInURL = "https://relay.bgenc.dev"

    /// The relay counts assertions and refuses one whose counter is not above the last,
    /// so an assertion is made and sent before the next one starts.
    static let assertionGate = SerialGate()

    var baseURL = URL(string: RelayClient.builtInURL)!
    var transport: any RelayTransport = URLSession.shared
    var asserter: (any RelayAsserter)?
    var gate: SerialGate = RelayClient.assertionGate

    func createChallenge() async throws -> String {
        struct Response: Decodable { var challenge: String }
        return try await decode(Response.self, method: "POST", path: "/v1/attest/challenges", body: nil, auth: nil).challenge
    }

    func register(token: String, environment: PushEnvironment, attestation: RelayAttestation?) async throws -> RelayRegistrationCreated {
        struct Body: Encodable {
            var token: String
            var environment: PushEnvironment
            var filtering = false
            var attestation: RelayAttestation?
        }
        let body = Body(token: token, environment: environment, attestation: attestation)
        return try await decode(RelayRegistrationCreated.self, method: "POST", path: "/v1/registrations", body: body, auth: nil)
    }

    func registration(_ auth: RelayAuth) async throws -> RelayRegistrationInfo {
        try await decode(RelayRegistrationInfo.self, method: "GET", path: "/v1/registrations/\(auth.id)", body: nil, auth: auth)
    }

    func update(_ auth: RelayAuth, token: String, environment: PushEnvironment) async throws -> RelayRegistrationStatus {
        struct Body: Encodable {
            var token: String
            var environment: PushEnvironment
            var filtering = false
        }
        return try await status(method: "PUT", path: "/v1/registrations/\(auth.id)", body: Body(token: token, environment: environment), auth: auth)
    }

    func delete(_ auth: RelayAuth) async throws {
        _ = try await send(method: "DELETE", path: "/v1/registrations/\(auth.id)", body: nil, auth: auth)
    }

    func proof(_ auth: RelayAuth, nonce: String) async throws -> RelayRegistrationStatus {
        try await status(method: "POST", path: "/v1/registrations/\(auth.id)/proof", body: ["nonce": nonce], auth: auth)
    }

    func proofPush(_ auth: RelayAuth) async throws {
        _ = try await send(method: "POST", path: "/v1/registrations/\(auth.id)/proof-push", body: nil, auth: auth)
    }

    /// `publicKey` is the host's Ed25519 signing key in base64.
    func createGrant(_ auth: RelayAuth, pairing: String, publicKey: String) async throws -> RelayGrantInfo {
        try await decode(
            RelayGrantInfo.self,
            method: "POST",
            path: "/v1/registrations/\(auth.id)/grants",
            body: ["pairing": pairing, "publicKey": publicKey],
            auth: auth
        )
    }

    /// The grant's new expiry in Unix seconds.
    func renewGrant(_ auth: RelayAuth, grant: String) async throws -> Int {
        struct Response: Decodable { var expiresAt: Int }
        return try await decode(Response.self, method: "POST", path: "/v1/registrations/\(auth.id)/grants/\(grant)/renew", body: nil, auth: auth).expiresAt
    }

    func deleteGrant(_ auth: RelayAuth, grant: String) async throws {
        _ = try await send(method: "DELETE", path: "/v1/registrations/\(auth.id)/grants/\(grant)", body: nil, auth: auth)
    }

    // MARK: Requests

    /// What an assertion signs: `<METHOD>\n<path>\n<hex SHA-256 of the body>`.
    static func clientData(method: String, path: String, body: Data) -> Data {
        Data("\(method)\n\(path)\n\(Data(SHA256.hash(data: body)).hex)".utf8)
    }

    static func encode(_ body: (any Encodable)?) -> Data {
        guard let body else { return Data() }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return (try? encoder.encode(body)) ?? Data()
    }

    func request(method: String, path: String, body: Data, auth: RelayAuth?, assertion: Data?) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !body.isEmpty {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let auth { request.setValue("Bearer \(auth.secret)", forHTTPHeaderField: "Authorization") }
        if let assertion { request.setValue(assertion.base64EncodedString(), forHTTPHeaderField: "Hobwork-Assertion") }
        return request
    }

    private func send(method: String, path: String, body: (any Encodable)?, auth: RelayAuth?) async throws -> (Data, Int) {
        let data = Self.encode(body)
        guard let auth, let keyId = auth.attestKeyId else {
            return try await load(request(method: method, path: path, body: data, auth: auth, assertion: nil))
        }
        guard let asserter else { throw RelayError.assertionUnavailable }
        let hash = Data(SHA256.hash(data: Self.clientData(method: method, path: path, body: data)))
        return try await gate.run {
            let assertion = try await asserter.assertion(keyId: keyId, clientDataHash: hash)
            return try await load(request(method: method, path: path, body: data, auth: auth, assertion: assertion))
        }
    }

    private func load(_ request: URLRequest) async throws -> (Data, Int) {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch let error as RelayError {
            throw error
        } catch {
            throw RelayError.unreachable(error.localizedDescription)
        }
        guard (200 ..< 300).contains(response.statusCode) else {
            let body = try? JSONDecoder().decode(JSONValue.self, from: data)
            throw RelayError.refused(
                status: response.statusCode,
                code: body?["error"]?.stringValue ?? "http_\(response.statusCode)",
                message: body?["message"]?.stringValue
            )
        }
        return (data, response.statusCode)
    }

    private func decode<T: Decodable>(_ type: T.Type, method: String, path: String, body: (any Encodable)?, auth: RelayAuth?) async throws -> T {
        let (data, _) = try await send(method: method, path: path, body: body, auth: auth)
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw RelayError.invalidResponse
        }
    }

    private func status(method: String, path: String, body: (any Encodable)?, auth: RelayAuth) async throws -> RelayRegistrationStatus {
        struct Response: Decodable { var status: RelayRegistrationStatus }
        return try await decode(Response.self, method: method, path: path, body: body, auth: auth).status
    }
}
