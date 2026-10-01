import CryptoKit
import Foundation
import Testing
import UserNotifications
@testable import Hobwork

/// `server/src/devices/push-vector.json`, which the host's tests check too.
struct PushVector {
    let json: JSONValue

    init() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "server/src/devices/push-vector.json")
        json = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    func bytes(_ key: String) throws -> Data {
        try #require(json[key]?.stringValue.flatMap { Data(base64Encoded: $0) })
    }

    func string(_ key: String) throws -> String {
        try #require(json[key]?.stringValue)
    }
}

struct PushCryptoTests {
    @Test func opensTheSharedVector() throws {
        let vector = try PushVector()
        let appKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: vector.bytes("appPrivateKey"))
        let hostKey = try vector.bytes("hostEncryptionKey")
        #expect(appKey.publicKey.rawRepresentation == (try vector.bytes("appKey")))
        #expect(PushCrypto.keyId(of: hostKey) == (try vector.string("keyId")))
        let secret = try PushCrypto.sharedSecret(appKey: appKey, hostKey: hostKey)
        #expect(secret.withUnsafeBytes { Data($0) } == (try vector.bytes("sharedSecret")))
        let contentKey = try PushCrypto.contentKey(appKey: appKey, hostKey: hostKey)
        #expect(contentKey.withUnsafeBytes { Data($0) } == (try vector.bytes("contentKey")))

        let plaintext = try PushCrypto.open(
            ciphertext: vector.bytes("ciphertext"), grant: vector.string("grant"), appKey: appKey, hostKey: hostKey
        )
        #expect(try JSONDecoder().decode(JSONValue.self, from: plaintext) == vector.json["plaintext"])
    }

    @Test func refusesAnotherGrant() throws {
        let vector = try PushVector()
        let appKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: vector.bytes("appPrivateKey"))
        #expect(throws: PushCrypto.Failure.badCiphertext) {
            try PushCrypto.open(ciphertext: vector.bytes("ciphertext"), grant: "another-grant", appKey: appKey, hostKey: vector.bytes("hostEncryptionKey"))
        }
    }

    @Test func unframesAndInflates() throws {
        let text = Data(String(repeating: "Hobwork pushes compress well. ", count: 200).utf8)
        let framed = TestSealer.frame(TestSealer.deflate(text))
        #expect(framed.count % 256 == 0)
        #expect(try PushCrypto.inflate(PushCrypto.unframe(framed)) == text)
    }

    @Test func refusesBadFraming() {
        #expect(throws: PushCrypto.Failure.badFraming) { try PushCrypto.unframe(Data([0, 0])) }
        #expect(throws: PushCrypto.Failure.badFraming) { try PushCrypto.unframe(Data([0, 0, 1, 0, 1, 2])) }
        #expect(throws: PushCrypto.Failure.badCompression) { try PushCrypto.inflate(Data([0xFF, 0xFF, 0xFF])) }
        #expect(throws: PushCrypto.Failure.badCompression) { try PushCrypto.inflate(Data()) }
    }

    @Test func refusesDecompressionBombs() {
        let huge = TestSealer.deflate(Data(count: PushCrypto.maxPlaintext * 2))
        #expect(throws: PushCrypto.Failure.badCompression) { try PushCrypto.inflate(huge) }
    }
}

@Suite(.serialized)
struct PushOpenerTests {
    let host = URL(string: "https://h.example.com")!
    let hostKey = Curve25519.KeyAgreement.PrivateKey()
    let store = PushStore(items: MemoryItems())
    let handled = HandledPushLog(file: temporaryFile([:]))
    let now = Date(timeIntervalSince1970: 1_790_841_600)
    let pairing: PushPairing

    init() throws {
        var pairing = PushPairing(host: host, keys: HostPushKeys(
            relay: RelayClient.builtInURL,
            signingKey: "c2lnbg==",
            encryptionKey: hostKey.publicKey.rawRepresentation.base64EncodedString(),
            keyId: PushCrypto.keyId(of: hostKey.publicKey.rawRepresentation)
        ))
        pairing.grant = PushPairing.Grant(id: "grant-1", expiresAt: now.addingTimeInterval(86400 * 30), signingKey: "c2lnbg==")
        try store.save(pairing)
        self.pairing = pairing
    }

    func opener(commandSeen: @escaping @Sendable (String) -> Bool = { _ in false }) -> PushOpener {
        PushOpener(store: store, handled: handled, commandSeen: commandSeen)
    }

    func seal(_ plaintext: String, grant: String = "grant-1") throws -> Data {
        try TestSealer.seal(Data(plaintext.utf8), grant: grant, hostKey: hostKey, appKey: #require(pairing.agreementKey).publicKey)
    }

    func notification(id: String = "n1", sentAt: Int = 1_790_841_600, expiresAt: Int = 1_790_928_000) -> String {
        """
        {"v":1,"sentAt":\(sentAt),"expiresAt":\(expiresAt),"aps":{"alert":{"title":"Kitchen","body":"Done."},"sound":"default","thread-id":"kitchen","category":"hobwork.\(id)","interruption-level":"time-sensitive"},"hobwork":{"id":"\(id)","project":"kitchen","actions":[{"id":"ok","title":"OK"}]}}
        """
    }

    @Test func opensANotificationAndRebuildsIt() throws {
        let opened = try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification()), now: now)
        #expect(opened.host == host)
        #expect(opened.handledId == "n1")
        let content = UNMutableNotificationContent()
        opened.apply(to: content)
        #expect(content.title == "Kitchen")
        #expect(content.body == "Done.")
        #expect(content.threadIdentifier == "kitchen")
        #expect(content.categoryIdentifier == "hobwork.n1")
        #expect(content.interruptionLevel == .timeSensitive)
        #expect(content.sound != nil)
        let payload = try #require(NotificationPayload(userInfo: content.userInfo))
        #expect(payload == NotificationPayload(id: "n1", project: "kitchen", actions: [NotificationAction(id: "ok", title: "OK")]))
        #expect(CommandPush(userInfo: content.userInfo) == nil)
    }

    @Test func opensACommand() throws {
        let plaintext = """
        {"v":1,"sentAt":1790841600,"expiresAt":1790842200,"aps":{"alert":{"title":"kitchen","body":"Fallback"},"interruption-level":"passive","thread-id":"kitchen"},"hobwork":{"project":"kitchen","command":{"id":"c1","capability":"focus","method":"status","args":{},"expiresAt":"2026-10-01T08:10:00Z","x":null}}}
        """
        let opened = try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(plaintext), now: now)
        #expect(opened.handledId == "c1")
        let content = UNMutableNotificationContent()
        opened.apply(to: content)
        #expect(content.interruptionLevel == .passive)
        #expect(content.sound == nil)
        let push = try #require(CommandPush(userInfo: content.userInfo))
        #expect(push.project == "kitchen")
        #expect(push.command.name == "focus.status")
    }

    @Test func dropsAPushForAnotherGrant() throws {
        #expect(throws: PushOpener.Drop.unknownGrant) {
            try opener().open(grant: "grant-2", keyId: pairing.keys.keyId, ciphertext: seal(notification(), grant: "grant-2"), now: now)
        }
    }

    @Test func dropsAPushSealedForAnotherGrant() throws {
        #expect(throws: PushOpener.Drop.unreadable) {
            try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification(), grant: "grant-2"), now: now)
        }
    }

    @Test func dropsAnUnknownKey() throws {
        #expect(throws: PushOpener.Drop.unknownKey) {
            try opener().open(grant: "grant-1", keyId: "unknown", ciphertext: seal(notification()), now: now)
        }
    }

    @Test func dropsExpiredPushes() throws {
        #expect(throws: PushOpener.Drop.expired) {
            try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification(expiresAt: 1_790_841_599)), now: now)
        }
        // 0 is no expiry.
        _ = try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification(id: "n2", expiresAt: 0)), now: now)
    }

    @Test func dropsPushesFromTheFuture() throws {
        #expect(throws: PushOpener.Drop.fromTheFuture) {
            try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification(sentAt: 1_790_841_600 + 301)), now: now)
        }
        _ = try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification(id: "n3", sentAt: 1_790_841_600 + 300)), now: now)
    }

    @Test func dropsRepeats() throws {
        _ = try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification()), now: now)
        #expect(throws: PushOpener.Drop.repeated("n1")) {
            try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification()), now: now)
        }
    }

    @Test func dropsNotificationsShownOverTheSocket() throws {
        handled.claim("n1", now: now)
        #expect(throws: PushOpener.Drop.repeated("n1")) {
            try opener().open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(notification()), now: now)
        }
    }

    @Test func dropsCommandsThatAlreadyRan() throws {
        let plaintext = """
        {"v":1,"sentAt":1790841600,"expiresAt":0,"aps":{"alert":{"title":"t","body":"b"}},"hobwork":{"command":{"id":"c9","capability":"focus","method":"status"}}}
        """
        #expect(throws: PushOpener.Drop.repeated("c9")) {
            try opener(commandSeen: { $0 == "c9" }).open(grant: "grant-1", keyId: pairing.keys.keyId, ciphertext: seal(plaintext), now: now)
        }
    }

    @Test func opensWithThePreviousKeyAfterTheHostChangesKeys() throws {
        let ciphertext = try seal(notification())
        var pairing = pairing
        let newKey = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        let signingChanged = pairing.update(HostPushKeys(
            relay: RelayClient.builtInURL, signingKey: "c2lnbg==",
            encryptionKey: newKey.base64EncodedString(), keyId: PushCrypto.keyId(of: newKey)
        ))
        #expect(!signingChanged)
        try store.save(pairing)
        _ = try opener().open(grant: "grant-1", keyId: self.pairing.keys.keyId, ciphertext: ciphertext, now: now)
    }

    @Test func readsRelayPushes() {
        #expect(RelayPush(userInfo: ["hobwork": ["v": 1, "proof": "n0nce"]]) == .proof(nonce: "n0nce"))
        #expect(RelayPush(userInfo: ["hobwork": ["v": 1, "renew": ["g1", "g2"]]]) == .renew(grants: ["g1", "g2"]))
        #expect(RelayPush(userInfo: ["hobwork": ["v": 1, "grant": "g1", "keyId": "k", "ciphertext": "AAEC"]])
            == .sealed(grant: "g1", keyId: "k", ciphertext: Data([0, 1, 2])))
        #expect(RelayPush(userInfo: ["hobwork": ["id": "n1", "project": "p"]]) == nil)
    }

    @Test func hidesRepeatsInTheForeground() {
        #expect(Notifier.presentation(for: [OpenedPush.repeatedKey: "n1"]) == [])
        #expect(Notifier.presentation(for: [:]) == [.banner, .list, .sound])
    }
}

struct RelayClientTests {
    let auth = RelayAuth(id: "reg1", secret: "s3cret", attestKeyId: nil)

    func body(_ request: URLRequest) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: #require(request.httpBody))
    }

    @Test func registersWithTheTokenAndAttestation() async throws {
        let transport = RecordingTransport()
        transport.answer = .object(["id": .string("reg1"), "secret": .string("s3cret"), "status": .string("pending")])
        let relay = RelayClient(transport: transport)
        let created = try await relay.register(
            token: "abcd", environment: .sandbox,
            attestation: RelayAttestation(keyId: "a2V5", object: "b2Jq", challenge: "ch")
        )
        #expect(created == RelayRegistrationCreated(id: "reg1", secret: "s3cret", status: .pending))
        let request = try #require(transport.requests.first)
        #expect(request.url?.absoluteString == "https://relay.bgenc.dev/v1/registrations")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(try body(request) == json(#"""
        {"token":"abcd","environment":"sandbox","attestation":{"keyId":"a2V5","object":"b2Jq","challenge":"ch"}}
        """#))
    }

    @Test func sendsTheSecretWithoutAssertionWhenUnattested() async throws {
        let transport = RecordingTransport()
        transport.answer = .object(["id": .string("g1"), "expiresAt": .number(1_793_433_600)])
        let grant = try await RelayClient(transport: transport).createGrant(auth, pairing: "p1", publicKey: "a2V5")
        #expect(grant == RelayGrantInfo(id: "g1", pairing: nil, expiresAt: 1_793_433_600))
        let request = try #require(transport.requests.first)
        #expect(request.url?.path == "/v1/registrations/reg1/grants")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer s3cret")
        #expect(request.value(forHTTPHeaderField: "Hobwork-Assertion") == nil)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(try body(request) == .object(["pairing": .string("p1"), "publicKey": .string("a2V5")]))
    }

    @Test func assertsOverMethodPathAndBodyHash() async throws {
        let transport = RecordingTransport()
        transport.answer = .object(["status": .string("active")])
        let attest = FakeAttest()
        let relay = RelayClient(transport: transport, asserter: attest, gate: SerialGate())
        let attested = RelayAuth(id: "reg1", secret: "s3cret", attestKeyId: "a2V5")
        _ = try await relay.proof(attested, nonce: "n1")

        let request = try #require(transport.requests.first)
        let body = try #require(request.httpBody)
        let clientData = "POST\n/v1/registrations/reg1/proof\n\(Data(SHA256.hash(data: body)).hex)"
        #expect(RelayClient.clientData(method: "POST", path: "/v1/registrations/reg1/proof", body: body) == Data(clientData.utf8))
        let hash = Data(SHA256.hash(data: Data(clientData.utf8)))
        #expect(attest.hashes == [hash])
        #expect(request.value(forHTTPHeaderField: "Hobwork-Assertion") == hash.base64EncodedString())
    }

    @Test func assertsOverAnEmptyBodyForGet() async throws {
        let transport = RecordingTransport()
        transport.answer = json(#"{"id":"reg1","status":"active","attested":true,"environment":"sandbox","grants":[{"id":"g1","pairing":"p1","expiresAt":5}]}"#)
        let attest = FakeAttest()
        let relay = RelayClient(transport: transport, asserter: attest, gate: SerialGate())
        let info = try await relay.registration(RelayAuth(id: "reg1", secret: "s", attestKeyId: "k"))
        #expect(info.grants == [RelayGrantInfo(id: "g1", pairing: "p1", expiresAt: 5)])
        let emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        #expect(attest.hashes == [Data(SHA256.hash(data: Data("GET\n/v1/registrations/reg1\n\(emptyHash)".utf8)))])
        #expect(transport.requests.first?.httpBody == nil)
    }

    @Test func sendsAssertedRequestsOneAtATime() async throws {
        let transport = RecordingTransport()
        transport.delay = .milliseconds(20)
        let attest = FakeAttest()
        attest.delay = .milliseconds(5)
        let relay = RelayClient(transport: transport, asserter: attest, gate: SerialGate())
        let attested = RelayAuth(id: "reg1", secret: "s", attestKeyId: "k")
        try await withThrowingTaskGroup(of: Void.self) { group in
            for index in 0 ..< 5 {
                group.addTask { try await relay.deleteGrant(attested, grant: "g\(index)") }
            }
            try await group.waitForAll()
        }
        #expect(!attest.overlapped)
        // Each request reached the relay before the next assertion was made.
        let sent = transport.requests.map { Data(base64Encoded: $0.value(forHTTPHeaderField: "Hobwork-Assertion") ?? "") }
        #expect(sent == attest.hashes)
    }

    @Test func refusesAttestedRequestsWithoutAnAsserter() async {
        let relay = RelayClient(transport: RecordingTransport())
        await #expect(throws: RelayError.assertionUnavailable) {
            try await relay.renewGrant(RelayAuth(id: "r", secret: "s", attestKeyId: "k"), grant: "g")
        }
    }

    @Test func readsErrorCodes() async {
        let transport = RecordingTransport()
        transport.status = 410
        transport.answer = .object(["error": .string("gone"), "message": .string("The device no longer takes pushes.")])
        await #expect(throws: RelayError.refused(status: 410, code: "gone", message: "The device no longer takes pushes.")) {
            try await RelayClient(transport: transport).renewGrant(auth, grant: "g")
        }
    }
}
