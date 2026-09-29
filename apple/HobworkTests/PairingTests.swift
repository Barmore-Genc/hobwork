import Foundation
import Testing
@testable import Hobwork

struct PKCETests {
    @Test func matchesTheRFC7636Example() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func randomVerifiersAreUnreservedAndLongEnough() {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let first = PKCE.random()
        #expect(first.verifier.count == 43)
        #expect(first.verifier.unicodeScalars.allSatisfy(allowed.contains))
        #expect(first.challenge.unicodeScalars.allSatisfy(allowed.contains))
        #expect(PKCE.random().verifier != first.verifier)
    }
}

struct PairingTests {
    let pairing = Pairing(
        host: URL(string: "https://hobwork.example.com")!,
        deviceName: "Kaan's iPhone+1",
        pkce: PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        state: "state123"
    )

    @Test func buildsTheConnectURL() throws {
        let components = try #require(URLComponents(url: pairing.url, resolvingAgainstBaseURL: false))
        #expect(components.scheme == "https")
        #expect(components.host == "hobwork.example.com")
        #expect(components.path == "/devices/connect")
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(items == [
            "name": "Kaan's iPhone+1",
            "platform": Hello.platform,
            "challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "state": "state123",
            "redirect_uri": "hobwork://paired",
        ])
    }

    @Test func encodesPlusSoServersDoNotReadASpace() {
        #expect(pairing.url.absoluteString.contains("iPhone%2B1"))
        #expect(pairing.url.absoluteString.contains("redirect_uri=hobwork://paired"))
    }

    @Test func keepsAPortInTheHost() {
        let local = Pairing(host: URL(string: "http://hobwork.localhost:5173")!, deviceName: "Sim")
        #expect(local.url.absoluteString.hasPrefix("http://hobwork.localhost:5173/devices/connect?"))
    }

    @Test func readsTheCode() throws {
        #expect(try pairing.code(from: URL(string: "hobwork://paired?code=abc&state=state123")!) == "abc")
    }

    @Test func rejectsAnotherState() {
        #expect(throws: Pairing.CallbackError.stateMismatch) {
            try pairing.code(from: URL(string: "hobwork://paired?code=abc&state=other")!)
        }
        #expect(throws: Pairing.CallbackError.stateMismatch) {
            try pairing.code(from: URL(string: "hobwork://paired?code=abc")!)
        }
    }

    @Test func reportsDenial() {
        #expect(throws: Pairing.CallbackError.denied("access_denied")) {
            try pairing.code(from: URL(string: "hobwork://paired?error=access_denied&state=state123")!)
        }
    }

    @Test func rejectsOtherRedirects() {
        #expect(throws: Pairing.CallbackError.wrongRedirect) {
            try pairing.code(from: URL(string: "hobwork://other?code=abc&state=state123")!)
        }
        #expect(throws: Pairing.CallbackError.missingCode) {
            try pairing.code(from: URL(string: "hobwork://paired?state=state123")!)
        }
    }
}
