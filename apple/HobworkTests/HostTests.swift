import Foundation
import Testing
@testable import Hobwork

struct HostURLTests {
    @Test(arguments: [
        ("hobwork.example.com", "https://hobwork.example.com"),
        ("  Hobwork.Example.com/projects?x=1#y ", "https://hobwork.example.com"),
        ("https://hobwork.example.com/", "https://hobwork.example.com"),
        ("https://hobwork.example.com:8443", "https://hobwork.example.com:8443"),
        ("http://localhost:7420", "http://localhost:7420"),
        ("http://hobwork.localhost:5173/login", "http://hobwork.localhost:5173"),
        ("http://nas.local", "http://nas.local"),
        ("http://192.168.1.20:7420", "http://192.168.1.20:7420"),
        ("http://[::1]:7420", "http://[::1]:7420"),
    ])
    func normalizes(input: String, expected: String) throws {
        #expect(try HostURL.normalize(input).absoluteString == expected)
    }

    @Test func refusesPlainHTTPForPublicHosts() {
        #expect(throws: HostURL.Invalid.insecure) { try HostURL.normalize("http://hobwork.example.com") }
        #expect(throws: HostURL.Invalid.insecure) { try HostURL.normalize("http://192.168.1") }
    }

    @Test(arguments: ["", "   ", "ftp://example.com", "https://"])
    func rejectsNonsense(input: String) {
        #expect(throws: HostURL.Invalid.malformed) { try HostURL.normalize(input) }
    }

    @Test func buildsTheWebSocketURL() {
        #expect(HostURL.webSocketURL(for: URL(string: "https://h.example.com")!, path: "api/devices/ws").absoluteString
            == "wss://h.example.com/api/devices/ws")
        #expect(HostURL.webSocketURL(for: URL(string: "http://localhost:7420")!, path: "api/devices/ws").absoluteString
            == "ws://localhost:7420/api/devices/ws")
    }

    @Test func sendsTheTokenOnTheWebSocket() {
        let api = HostAPI(host: URL(string: "https://h.example.com")!, token: "hwd_abc")
        #expect(api.webSocketRequest.value(forHTTPHeaderField: "Authorization") == "Bearer hwd_abc")
    }
}

struct HostRequestTests {
    let api = HostAPI(host: URL(string: "https://h.example.com")!, token: "hwd_abc")

    func body(_ request: URLRequest) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: #require(request.httpBody))
    }

    @Test func exchangesTheCodeWithTheVerifier() throws {
        let request = HostAPI(host: api.host).exchangeRequest(code: "c1", verifier: "v1")
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://h.example.com/api/devices/token")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(try body(request) == .object(["code": .string("c1"), "codeVerifier": .string("v1")]))
    }

    @Test func decodesCredentials() throws {
        let credentials = try JSONDecoder().decode(DeviceCredentials.self, from: Data(#"{"deviceId":7,"name":"kaans-iphone","token":"hwd_x"}"#.utf8))
        #expect(credentials == DeviceCredentials(deviceId: 7, name: "kaans-iphone", token: "hwd_x"))
    }

    @Test func asksForAWebSession() throws {
        let request = api.webSessionRequest(returnTo: "/auth/app?project=filament")
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/devices/web-session")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer hwd_abc")
        #expect(try body(request) == .object(["returnTo": .string("/auth/app?project=filament")]))
    }

    @Test func updatesAndClearsThePushGrant() throws {
        let set = api.pushRequest(HostPushGrant(grant: "g1", key: "a2V5"))
        #expect(set.httpMethod == "PUT")
        #expect(set.url?.path == "/api/devices/push")
        #expect(try body(set) == .object(["grant": .string("g1"), "key": .string("a2V5")]))
        #expect(try body(api.pushRequest(nil)) == .object(["grant": .null]))
    }

    @Test func decodesThePushKeysOfTheExchange() throws {
        let withPush = try JSONDecoder().decode(PairingExchange.self, from: Data(#"""
        {"deviceId":7,"name":"kaans-iphone","token":"hwd_x","push":{"relay":"https://relay.bgenc.dev","signingKey":"cw==","encryptionKey":"ZQ==","keyId":"k1"}}
        """#.utf8))
        #expect(withPush == PairingExchange(
            credentials: DeviceCredentials(deviceId: 7, name: "kaans-iphone", token: "hwd_x"),
            push: HostPushKeys(relay: "https://relay.bgenc.dev", signingKey: "cw==", encryptionKey: "ZQ==", keyId: "k1")
        ))
        let off = try JSONDecoder().decode(PairingExchange.self, from: Data(#"{"deviceId":7,"name":"n","token":"hwd_x","push":null}"#.utf8))
        #expect(off.push == nil)
        let older = try JSONDecoder().decode(PairingExchange.self, from: Data(#"{"deviceId":7,"name":"n","token":"hwd_x"}"#.utf8))
        #expect(older.push == nil)
    }

    @Test func removesItself() {
        #expect(api.removeRequest.httpMethod == "DELETE")
        #expect(api.removeRequest.url?.path == "/api/devices/self")
        #expect(api.removeRequest.value(forHTTPHeaderField: "Authorization") == "Bearer hwd_abc")
    }

    @Test func postsEvents() throws {
        let event = DeviceEvent(capability: "notifications", name: "action", data: .object(["id": .string("n1"), "action": .string("ok")]))
        let request = api.eventRequest(event)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/devices/events")
        #expect(try body(request) == .object([
            "capability": .string("notifications"),
            "name": .string("action"),
            "data": .object(["id": .string("n1"), "action": .string("ok")]),
        ]))
    }
}

struct HostProbeTests {
    func parse(_ status: Int, _ body: String) throws(HostProbeError) -> HostInfo {
        try HostInfo.parse(status: status, data: Data(body.utf8))
    }

    @Test func acceptsAHobworkHost() throws {
        #expect(try parse(200, #"{"hobwork":1,"name":"Home","version":"0.4.0"}"#)
            == HostInfo(hobwork: 1, name: "Home", version: "0.4.0"))
    }

    @Test func reportsTheStatusOfOtherServers() {
        #expect(throws: HostProbeError.notHobwork(status: 404)) { try parse(404, "Not found") }
        #expect(throws: HostProbeError.notHobwork(status: 502)) { try parse(502, "") }
    }

    @Test func rejectsAnswersThatAreNotHobwork() {
        #expect(throws: HostProbeError.notHobwork(status: nil)) { try parse(200, "<html></html>") }
        #expect(throws: HostProbeError.notHobwork(status: nil)) { try parse(200, #"{"name":"Other"}"#) }
        #expect(throws: HostProbeError.notHobwork(status: nil)) { try parse(200, #"{"hobwork":"yes"}"#) }
    }

    @Test func rejectsNewerProtocols() {
        #expect(throws: HostProbeError.unsupportedVersion(2)) { try parse(200, #"{"hobwork":2,"name":"Home","version":"9.0"}"#) }
    }

    @Test(arguments: [
        (URLError.Code.notConnectedToInternet, HostProbeError.offline),
        (.dataNotAllowed, .offline),
        (.cannotFindHost, .hostNotFound),
        (.dnsLookupFailed, .hostNotFound),
        (.cannotConnectToHost, .connectionRefused),
        (.timedOut, .timedOut),
        (.secureConnectionFailed, .certificate),
        (.serverCertificateUntrusted, .certificate),
        (.serverCertificateHasBadDate, .certificate),
        (.serverCertificateHasUnknownRoot, .certificate),
        (.appTransportSecurityRequiresSecureConnection, .insecure),
    ])
    func mapsNetworkErrors(code: URLError.Code, expected: HostProbeError) {
        #expect(HostProbeError(URLError(code)) == expected)
    }

    @Test func keepsTheReasonForOtherFailures() {
        guard case let .unreachable(reason) = HostProbeError(URLError(.networkConnectionLost)) else {
            Issue.record("expected unreachable")
            return
        }
        #expect(!reason.isEmpty)
    }

    @Test func explainsEveryCase() {
        let cases: [HostProbeError] = [
            .offline, .hostNotFound, .connectionRefused, .timedOut, .unreachable("x"), .certificate, .insecure,
            .notHobwork(status: 404), .notHobwork(status: nil), .unsupportedVersion(2),
        ]
        for error in cases {
            #expect(error.errorDescription?.isEmpty == false)
        }
        #expect(HostProbeError.notHobwork(status: 404).errorDescription?.contains("HTTP 404") == true)
        #expect(HostProbeError.offline.errorDescription?.contains("offline") == true)
    }
}

struct LinkPolicyTests {
    let policy = LinkPolicy(host: URL(string: "https://hobwork.example.com")!)

    @Test(arguments: [
        "https://hobwork.example.com/projects/filament",
        "https://filament.apps.hobwork.example.com/",
        "https://main--filament.apps.hobwork.example.com/x",
        "https://filament.apps.example.com/",
    ])
    func keepsHobworkInTheApp(link: String) {
        #expect(policy.opensInApp(URL(string: link)!))
    }

    @Test(arguments: [
        "https://example.com/",
        "https://github.com/kaan/hobwork",
        "https://apps.example.com.evil.net/",
        "https://filament.apps.example.org/",
        "mailto:kaan@example.com",
    ])
    func opensTheRestOutside(link: String) {
        #expect(!policy.opensInApp(URL(string: link)!))
    }

    @Test func handlesLocalDevelopmentHosts() {
        let local = LinkPolicy(host: URL(string: "http://hobwork.localhost:5173")!)
        #expect(local.opensInApp(URL(string: "http://filament.apps.hobwork.localhost:7420/")!))
        #expect(local.opensInApp(URL(string: "http://filament.apps.localhost:7420/")!))
        #expect(!local.opensInApp(URL(string: "http://other.localhost/")!))
    }

    @Test func spotsTheSignInPage() {
        #expect(policy.isSignInPage(URL(string: "https://hobwork.example.com/login?returnTo=%2Fauth%2Fapp")!))
        #expect(!policy.isSignInPage(URL(string: "https://filament.apps.hobwork.example.com/login")!))
        #expect(!policy.isSignInPage(URL(string: "https://hobwork.example.com/projects")!))
    }

    @Test func findsWhereToGoAfterSigningIn() {
        func returnTo(_ link: String) -> String? {
            policy.returnTo(forSignInPage: URL(string: link)!, linkDestination: "/projects/filament")
        }
        #expect(returnTo("https://hobwork.example.com/login?returnTo=%2Fauth%2Fapp%3Fproject%3Dfilament") == "/auth/app?project=filament")
        #expect(returnTo("https://hobwork.example.com/login?error=link_expired") == "/projects/filament")
        #expect(returnTo("https://hobwork.example.com/login") == "/")
        #expect(returnTo("https://hobwork.example.com/login?returnTo=https%3A%2F%2Fevil.example") == "/")
        #expect(returnTo("https://hobwork.example.com/projects") == nil)
    }

    @Test func resolvesPaths() {
        #expect(policy.url(forPath: "/projects/filament?x=1")?.absoluteString == "https://hobwork.example.com/projects/filament?x=1")
        #expect(policy.url(forPath: "https://filament.apps.hobwork.example.com/")?.absoluteString == "https://filament.apps.hobwork.example.com/")
    }
}
