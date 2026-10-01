import Foundation
import Testing
@testable import Hobwork

private let integrationHost = ProcessInfo.processInfo.environment["HOBWORK_TEST_HOST"].flatMap(URL.init(string:))

/// Runs the device protocol against a real host: `just test-host <url> <session cookie>`.
/// The pairing page is approved through its API with a signed-in person's cookie, the
/// rest goes through the app's own code.
@MainActor
@Suite(.enabled(if: integrationHost != nil))
struct HostIntegrationTests {
    let host = integrationHost!
    let cookie = ProcessInfo.processInfo.environment["HOBWORK_TEST_COOKIE"] ?? ""

    /// What the web pairing page does when the person taps "Connect device".
    func approve(_ pairing: Pairing, name: String) async throws -> URL {
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: pairing.url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            .map { ($0.name, JSONValue.string($0.value ?? "")) })
        var request = URLRequest(url: host.appending(path: "api/devices/pairing/approve"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("1", forHTTPHeaderField: "x-hobwork-csrf")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.httpBody = try JSONEncoder().encode(JSONValue.object(["request": .object(query), "name": .string(name)]))
        let (data, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200, "\(String(decoding: data, as: UTF8.self))")
        let body = try JSONDecoder().decode(JSONValue.self, from: data)
        return try #require(body["redirectTo"]?.stringValue.flatMap(URL.init(string:)))
    }

    func removeDevice(_ id: Int) async throws {
        var request = URLRequest(url: host.appending(path: "api/devices/\(id)/revoke"))
        request.httpMethod = "POST"
        request.setValue("1", forHTTPHeaderField: "x-hobwork-csrf")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        let (_, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode ?? 0 < 300)
    }

    @Test func pairsConnectsAndGetsRemoved() async throws {
        let info = try await HostAPI(host: host).probe()
        #expect(info.hobwork == 1)

        let name = "ios-test-\(Int.random(in: 1000 ... 9999))"
        let pairing = Pairing(host: host, deviceName: "iOS test")
        let code = try await pairing.code(from: approve(pairing, name: name))
        let credentials = try await HostAPI(host: host).exchange(code: code, verifier: pairing.pkce.verifier).credentials
        #expect(credentials.name == name)
        #expect(credentials.token.hasPrefix("hwd_"))

        let api = HostAPI(host: host, token: credentials.token)
        let link = try await api.webSession(returnTo: "/settings")
        #expect(link.path == "/auth/device")
        let key = PushPairing(host: host, keys: HostPushKeys(relay: "", signingKey: "", encryptionKey: "", keyId: "")).appKey
        try await api.updatePush(HostPushGrant(grant: Base64URL.encode(randomBytes(16)), key: key))
        try await api.updatePush(nil)

        let connection = DeviceConnection(
            request: api.webSocketRequest,
            hello: { Hello(appVersion: "test", platform: Hello.platform, capabilities: ["notifications"], push: nil) },
            queue: MemoryEventQueue()
        )
        var removed = false
        connection.onUnauthorized = { removed = true }
        connection.start()
        try await eventually("connected", timeout: .seconds(5)) { connection.state == .connected }
        try await Task.sleep(for: .seconds(1))
        #expect(connection.state == .connected)

        try await removeDevice(credentials.deviceId)
        try await eventually("removed", timeout: .seconds(5)) { connection.state == .unauthorized }
        #expect(removed)
        await #expect(throws: HostError.unauthorized) { try await api.webSession(returnTo: "/") }
    }

    @Test func signingOutRemovesTheDevice() async throws {
        let pairing = Pairing(host: host, deviceName: "iOS test")
        let code = try await pairing.code(from: approve(pairing, name: "ios-test-\(Int.random(in: 1000 ... 9999))"))
        let credentials = try await HostAPI(host: host).exchange(code: code, verifier: pairing.pkce.verifier).credentials
        let api = HostAPI(host: host, token: credentials.token)
        try await api.removeDevice()
        await #expect(throws: HostError.unauthorized) { try await api.removeDevice() }
    }

    @Test func refusesAnUnknownToken() async throws {
        let api = HostAPI(host: host, token: "hwd_not-a-real-token")
        let connection = DeviceConnection(
            request: api.webSocketRequest,
            hello: { Hello(appVersion: "test", platform: Hello.platform, capabilities: [], push: nil) },
            queue: MemoryEventQueue()
        )
        connection.start()
        try await eventually("unauthorized", timeout: .seconds(5)) { connection.state == .unauthorized }
    }
}
