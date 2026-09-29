import Foundation

enum HostURL {
    enum Invalid: Error, Equatable, LocalizedError {
        case malformed
        case insecure

        var errorDescription: String? {
            switch self {
            case .malformed: "Enter the address of your Hobwork host, for example hobwork.example.com."
            case .insecure: "Use https. Plain http only works for local addresses such as localhost, .local names and IP addresses."
            }
        }
    }

    /// Turns what someone typed into the host's origin: https unless they wrote http,
    /// without path, query or trailing slash.
    static func normalize(_ input: String) throws(Invalid) -> URL {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw .malformed }
        if !text.contains("://") { text = "https://" + text }
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host?.lowercased(), !host.isEmpty
        else { throw .malformed }
        if scheme == "http", !isLocal(host) { throw .insecure }
        components.scheme = scheme
        components.host = host
        components.path = ""
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        guard let url = components.url else { throw .malformed }
        return url
    }

    static func isLocal(_ host: String) -> Bool {
        let host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return true }
        if host.contains(":") { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { UInt8($0) != nil }
    }

    static func webSocketURL(for host: URL, path: String) -> URL {
        var components = URLComponents(url: host.appending(path: path), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        return components.url!
    }
}

enum HostError: Error, Equatable, LocalizedError {
    case notHobwork
    case unreachable(String)
    /// The device token was rejected: the device was removed on the host.
    case unauthorized
    /// The device's owner may not sign in to the host right now (403 `not_allowed`).
    /// The token works again once they are allowed back.
    case ownerNotAllowed
    case failed(status: Int, message: String?)

    var errorDescription: String? {
        switch self {
        case .notHobwork: "The host sent an answer this app does not understand."
        case let .unreachable(reason): reason
        case .unauthorized: "This device is no longer paired with the host."
        case .ownerNotAllowed: "Your account can't sign in to this host right now. Ask the person who runs it to add you back."
        case let .failed(status, message): message ?? "The host answered with HTTP \(status)."
        }
    }
}

struct DeviceCredentials: Codable, Equatable, Sendable {
    var deviceId: Int
    /// The name projects use for this device, as approved on the host.
    var name: String
    var token: String
}

/// The host's HTTP endpoints for devices.
struct HostAPI: Sendable {
    let host: URL
    var token: String?
    var session: URLSession = .shared

    /// Checks that the address is a Hobwork host this app can talk to.
    func probe() async throws(HostProbeError) -> HostInfo {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request(method: "GET", path: ".well-known/hobwork"))
        } catch {
            throw HostProbeError(error)
        }
        return try HostInfo.parse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data)
    }

    func exchange(code: String, verifier: String) async throws -> DeviceCredentials {
        try await decode(DeviceCredentials.self, exchangeRequest(code: code, verifier: verifier))
    }

    /// A one-time URL that signs the web view in and then opens `returnTo`.
    func webSession(returnTo: String) async throws -> URL {
        struct Response: Decodable { var url: String }
        let response = try await decode(Response.self, webSessionRequest(returnTo: returnTo))
        guard let url = URL(string: response.url, relativeTo: host)?.absoluteURL else { throw HostError.notHobwork }
        return url
    }

    /// Sets the APNs token, or turns push off with nil.
    func updatePush(_ push: PushRegistration?) async throws {
        _ = try await send(pushRequest(push))
    }

    func send(_ event: DeviceEvent) async throws {
        _ = try await send(eventRequest(event))
    }

    /// Removes this device from the host, as removing it in the web UI does.
    func removeDevice() async throws {
        _ = try await send(removeRequest)
    }

    var removeRequest: URLRequest {
        request(method: "DELETE", path: "api/devices/self")
    }

    func exchangeRequest(code: String, verifier: String) -> URLRequest {
        request(method: "POST", path: "api/devices/token", body: ["code": code, "codeVerifier": verifier])
    }

    func webSessionRequest(returnTo: String) -> URLRequest {
        request(method: "POST", path: "api/devices/web-session", body: ["returnTo": returnTo])
    }

    func pushRequest(_ push: PushRegistration?) -> URLRequest {
        let body: any Encodable = push ?? JSONValue.object(["token": .null])
        return request(method: "PUT", path: "api/devices/push", body: body)
    }

    func eventRequest(_ event: DeviceEvent) -> URLRequest {
        request(method: "POST", path: "api/devices/events", body: event)
    }

    var webSocketRequest: URLRequest {
        var request = URLRequest(url: HostURL.webSocketURL(for: host, path: "api/devices/ws"))
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func request(method: String, path: String, body: (any Encodable)? = nil) -> URLRequest {
        var request = URLRequest(url: host.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try? JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func load(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw HostError.notHobwork }
            return (data, http)
        } catch let error as HostError {
            throw error
        } catch {
            throw HostError.unreachable(HostProbeError(error).errorDescription ?? error.localizedDescription)
        }
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await load(request)
        switch response.statusCode {
        case 200 ..< 300: return data
        case 401 where token != nil: throw HostError.unauthorized
        default:
            let message = (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.stringValue
            if response.statusCode == 403, message == "not_allowed" { throw HostError.ownerNotAllowed }
            throw HostError.failed(status: response.statusCode, message: message)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ request: URLRequest) async throws -> T {
        let data = try await send(request)
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw HostError.notHobwork
        }
    }
}
