import Foundation
import Testing
@testable import Hobwork

@MainActor
final class PushHarness {
    let relay = FakeRelay()
    let store = PushStore(items: MemoryItems())
    let inbox = temporaryFile(ProofNotice?.none)
    let attest: FakeAttest?
    var coordinator: PushCoordinator!
    var told: [(URL, HostPushGrant?)] = []
    let host = URL(string: "https://h.example.com")!

    init(attest: FakeAttest? = nil, timing: PushCoordinator.Timing = PushCoordinator.Timing(poll: .milliseconds(1), pollsBeforeProofPush: 5, maxPolls: 40)) {
        self.attest = attest
        relay.inbox = inbox
        let relay = self.relay
        coordinator = PushCoordinator(
            relay: RelayClient(transport: relay, asserter: attest, gate: SerialGate()),
            store: store,
            attester: attest,
            proofInbox: inbox,
            timing: timing,
            now: { Date(timeIntervalSince1970: TimeInterval(relay.now)) }
        )
        coordinator.onGrantChange = { [weak self] host, grant in self?.told.append((host, grant)) }
    }

    func keys(signing: String = "c2lnbmluZy0x") -> HostPushKeys {
        HostPushKeys(relay: RelayClient.builtInURL, signingKey: signing, encryptionKey: "ZW5j", keyId: "k1")
    }

    /// A token, an active registration and a grant for `host`.
    func setUp() async {
        await coordinator.tokenArrived("aabbccdd", environment: .sandbox).value
        await coordinator.hostKeysChanged(host: host, keys: keys()).value
    }
}

@Suite(.serialized)
@MainActor
struct PushCoordinatorTests {
    @Test func registersAnswersTheProofAndMakesAGrant() async throws {
        let harness = PushHarness()
        await harness.coordinator.tokenArrived("aabbccdd", environment: .sandbox).value
        let registration = try #require(harness.store.registration())
        #expect(registration.status == .active)
        #expect(registration.attestKeyId == nil)
        #expect(registration.token == "aabbccdd")
        #expect(harness.relay.requests("POST", "/proof").count == 1)
        #expect(harness.inbox.read() == nil)

        await harness.coordinator.hostKeysChanged(host: harness.host, keys: harness.keys()).value
        let pairing = try #require(harness.store.pairing(for: harness.host))
        let grant = try #require(pairing.grant)
        #expect(harness.relay.grants.map(\.publicKey) == ["c2lnbmluZy0x"])
        #expect(harness.relay.grants.map(\.pairing) == [pairing.pairingId])
        #expect(Data(base64URL: pairing.pairingId)?.count == 16)
        #expect(harness.told.count == 1)
        #expect(harness.told.first?.1 == HostPushGrant(grant: grant.id, key: pairing.appKey))
        #expect(harness.coordinator.hostGrant(for: harness.host) == HostPushGrant(grant: grant.id, key: pairing.appKey))
        #expect(Data(base64Encoded: pairing.appKey)?.count == 32)
    }

    @Test func makesTheGrantOnceTheRegistrationIsActive() async throws {
        let harness = PushHarness()
        await harness.coordinator.hostKeysChanged(host: harness.host, keys: harness.keys()).value
        #expect(harness.relay.grants.isEmpty)
        #expect(harness.coordinator.hostGrant(for: harness.host) == nil)
        await harness.coordinator.tokenArrived("aabbccdd", environment: .sandbox).value
        #expect(harness.relay.grants.count == 1)
        #expect(harness.coordinator.hostGrant(for: harness.host) != nil)
    }

    @Test func leavesTheProofToTheExtensionWhenItAnswered() async throws {
        let harness = PushHarness()
        harness.relay.extensionConfirms = true
        await harness.coordinator.tokenArrived("aabbccdd", environment: .sandbox).value
        #expect(harness.store.registration()?.status == .active)
        #expect(harness.relay.requests("POST", "/proof").isEmpty)
    }

    @Test func asksForAnotherProofPushWhenNoneCame() async throws {
        let harness = PushHarness()
        harness.relay.deliversProofs = false
        let task = harness.coordinator.tokenArrived("aabbccdd", environment: .sandbox)
        try await eventually("proof push") { !harness.relay.requests("POST", "/proof-push").isEmpty }
        harness.relay.deliversProofs = true
        await task.value
        // The push arrived after the first ask, so the next ask never came.
        #expect(harness.relay.requests("POST", "/proof-push").count >= 1)
        #expect(harness.store.registration()?.status == .active)
    }

    @Test func givesUpAndFinishesOnTheNextRefresh() async throws {
        let harness = PushHarness()
        harness.relay.deliversProofs = false
        await harness.coordinator.tokenArrived("aabbccdd", environment: .sandbox).value
        #expect(harness.store.registration()?.status == .pending)
        harness.relay.deliversProofs = true
        await harness.coordinator.refresh().value
        #expect(harness.store.registration()?.status == .active)
        #expect(harness.relay.registrations.count == 1)
    }

    @Test func keepsTheRegistrationForTheSameToken() async throws {
        let harness = PushHarness()
        await harness.setUp()
        await harness.coordinator.tokenArrived("aabbccdd", environment: .sandbox).value
        #expect(harness.relay.requests("POST", "/v1/registrations").count == 1)
        #expect(harness.relay.requests("PUT", "").isEmpty)
    }

    @Test func movesToANewToken() async throws {
        let harness = PushHarness()
        await harness.setUp()
        let grant = try #require(harness.store.pairing(for: harness.host)?.grant)
        await harness.coordinator.tokenArrived("11223344", environment: .sandbox).value
        #expect(harness.relay.requests("PUT", "").count == 1)
        #expect(harness.relay.registrations.first?.token == "11223344")
        #expect(harness.store.registration()?.token == "11223344")
        // The fake relay keeps grants when the token changes from one that worked.
        #expect(harness.store.pairing(for: harness.host)?.grant == grant)
    }

    @Test func replacesTheGrantForANewSigningKey() async throws {
        let harness = PushHarness()
        await harness.setUp()
        let old = try #require(harness.store.pairing(for: harness.host)?.grant)
        let pairingId = harness.store.pairing(for: harness.host)?.pairingId
        await harness.coordinator.hostKeysChanged(host: harness.host, keys: harness.keys(signing: "c2lnbmluZy0y")).value
        let new = try #require(harness.store.pairing(for: harness.host)?.grant)
        #expect(new.id != old.id)
        #expect(new.signingKey == "c2lnbmluZy0y")
        #expect(harness.relay.grants.map(\.id) == [new.id])
        #expect(harness.relay.grants.map(\.publicKey) == ["c2lnbmluZy0y"])
        #expect(harness.store.pairing(for: harness.host)?.pairingId == pairingId)
        #expect(harness.told.last?.1?.grant == new.id)
    }

    @Test func doesNothingForTheSameKeys() async throws {
        let harness = PushHarness()
        await harness.setUp()
        let count = harness.relay.requests.count
        await harness.coordinator.hostKeysChanged(host: harness.host, keys: harness.keys()).value
        #expect(harness.relay.requests.count == count)
        #expect(harness.told.count == 1)
    }

    @Test(arguments: [nil, HostPushKeys(relay: "https://relay.evil.example", signingKey: "c2lnbmluZy0x", encryptionKey: "ZW5j", keyId: "k1")])
    func turnsPushOffForNoRelayOrAnotherOne(keys: HostPushKeys?) async throws {
        let harness = PushHarness()
        await harness.setUp()
        await harness.coordinator.hostKeysChanged(host: harness.host, keys: keys).value
        #expect(harness.store.pairing(for: harness.host) == nil)
        #expect(harness.relay.grants.isEmpty)
        #expect(harness.told.last?.1 == nil)
        #expect(harness.told.count == 2)
        #expect(harness.coordinator.hostGrant(for: harness.host) == nil)
    }

    @Test func neverMakesAGrantForAnotherRelay() async throws {
        let harness = PushHarness()
        await harness.coordinator.tokenArrived("aabbccdd", environment: .sandbox).value
        var keys = harness.keys()
        keys.relay = "https://relay.evil.example"
        await harness.coordinator.hostKeysChanged(host: harness.host, keys: keys).value
        #expect(harness.relay.grants.isEmpty)
        #expect(harness.told.isEmpty)
    }

    @Test func renewsGrantsCloseToExpiry() async throws {
        let harness = PushHarness()
        await harness.setUp()
        let grant = try #require(harness.store.pairing(for: harness.host)?.grant)
        harness.relay.now += 16 * 86400
        await harness.coordinator.refresh().value
        let renewed = try #require(harness.store.pairing(for: harness.host)?.grant)
        #expect(renewed.id == grant.id)
        #expect(renewed.expiresAt == Date(timeIntervalSince1970: TimeInterval(harness.relay.now + 30 * 86400)))
        #expect(harness.told.count == 1)
    }

    @Test func leavesGrantsWithTimeLeft() async throws {
        let harness = PushHarness()
        await harness.setUp()
        harness.relay.now += 10 * 86400
        await harness.coordinator.refresh().value
        #expect(harness.relay.requests("POST", "/renew").isEmpty)
    }

    @Test func renewsTheGrantsARenewalPushLists() async throws {
        let harness = PushHarness()
        await harness.setUp()
        let grant = try #require(harness.store.pairing(for: harness.host)?.grant)
        harness.relay.now += 86400
        await harness.coordinator.renew(grants: ["other"]).value
        #expect(harness.relay.requests("POST", "/renew").isEmpty)
        await harness.coordinator.renew(grants: [grant.id]).value
        #expect(harness.relay.requests("POST", "/renew").count == 1)
        #expect(harness.store.pairing(for: harness.host)?.grant?.expiresAt == Date(timeIntervalSince1970: TimeInterval(harness.relay.now + 30 * 86400)))
    }

    @Test func makesANewGrantWhenTheOldOneExpired() async throws {
        let harness = PushHarness()
        await harness.setUp()
        let grant = try #require(harness.store.pairing(for: harness.host)?.grant)
        harness.relay.setExpiry(harness.relay.now - 1, grant: grant.id)
        harness.relay.now += 20 * 86400
        await harness.coordinator.refresh().value
        let new = try #require(harness.store.pairing(for: harness.host)?.grant)
        #expect(new.id != grant.id)
        #expect(harness.told.last?.1?.grant == new.id)
    }

    @Test func registersAgainWhenTheTokenIsGone() async throws {
        let harness = PushHarness()
        await harness.setUp()
        let registration = try #require(harness.store.registration())
        let grant = try #require(harness.store.pairing(for: harness.host)?.grant)
        harness.relay.dropToken(of: registration.id)
        await harness.coordinator.refresh().value
        // The same registration takes the token again with a new proof, which drops its grants.
        #expect(harness.relay.registrations.count == 1)
        #expect(harness.store.registration()?.status == .active)
        let new = try #require(harness.store.pairing(for: harness.host)?.grant)
        #expect(new.id != grant.id)
        #expect(harness.relay.grants.map(\.id) == [new.id])
        #expect(harness.told.map { $0.1?.grant } == [grant.id, nil, new.id])
    }

    @Test func startsOverWhenTheRelayForgotTheRegistration() async throws {
        let harness = PushHarness()
        await harness.setUp()
        let registration = try #require(harness.store.registration())
        harness.relay.forget(registration: registration.id)
        await harness.coordinator.refresh().value
        let new = try #require(harness.store.registration())
        #expect(new.id != registration.id)
        #expect(new.status == .active)
        #expect(harness.store.pairing(for: harness.host)?.grant != nil)
    }

    @Test func forgetsAPairing() async throws {
        let harness = PushHarness()
        await harness.setUp()
        await harness.coordinator.forget(host: harness.host).value
        #expect(harness.relay.grants.isEmpty)
        #expect(harness.store.pairing(for: harness.host) == nil)
        #expect(harness.store.registration() != nil)
    }

    @Test func registersWithAppAttest() async throws {
        let attest = FakeAttest()
        let harness = PushHarness(attest: attest)
        await harness.setUp()
        let registration = try #require(harness.store.registration())
        #expect(registration.attestKeyId == "a2V5LWlk")
        let create = try #require(harness.relay.requests("POST", "/v1/registrations").first)
        let body = try JSONDecoder().decode(JSONValue.self, from: #require(create.httpBody))
        #expect(body["attestation"]?["keyId"] == .string("a2V5LWlk"))
        #expect(body["attestation"]?["challenge"] == .string("challenge1"))
        #expect(harness.relay.registrations.first?.attested == true)
        // Every request after registering carries an assertion.
        let later = harness.relay.requests.filter { ($0.url?.path ?? "").hasPrefix("/v1/registrations/") }
        #expect(!later.isEmpty)
        #expect(later.allSatisfy { $0.value(forHTTPHeaderField: "Hobwork-Assertion") != nil })
        #expect(attest.hashes.count == later.count)
        #expect(harness.store.pairing(for: harness.host)?.grant != nil)
    }

    @Test func registersWithoutAppAttestWhereItIsMissing() async throws {
        let attest = FakeAttest()
        attest.isSupported = false
        let harness = PushHarness(attest: attest)
        await harness.setUp()
        #expect(harness.store.registration()?.attestKeyId == nil)
        #expect(harness.relay.requests("POST", "/challenges").isEmpty)
        #expect(attest.hashes.isEmpty)
    }
}

extension Data {
    init?(base64URL text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }
}
