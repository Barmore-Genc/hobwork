import CryptoKit
import Foundation
import Testing
@testable import Hobwork

typealias LiveState = HobworkActivityAttributes.ContentState

@MainActor
final class FakeLiveActivitySystem: LiveActivitySystem {
    var areEnabled = true
    var frequentPushesEnabled = false
    var started: [(HobworkActivityAttributes, LiveActivityContent)] = []
    var updated: [(String, LiveActivityContent)] = []
    var ended: [(String, LiveActivityContent?, LiveActivityDismissal)] = []
    var running: Set<String> = []

    func start(_ attributes: HobworkActivityAttributes, content: LiveActivityContent) throws -> String {
        started.append((attributes, content))
        running.insert(attributes.id)
        return "activity-\(started.count)"
    }

    func update(id: String, content: LiveActivityContent) async -> Bool {
        updated.append((id, content))
        return running.contains(id)
    }

    func end(id: String, content: LiveActivityContent?, dismissal: LiveActivityDismissal) async -> Bool {
        ended.append((id, content, dismissal))
        return running.remove(id) != nil
    }
}

@Suite(.serialized)
struct LiveLiveStateTests {
    let host = URL(string: "https://h.example.com")!
    let hostKey = Curve25519.KeyAgreement.PrivateKey()
    let store = PushStore(items: MemoryItems())
    let pairing: PushPairing

    init() throws {
        var pairing = PushPairing(host: host, keys: HostPushKeys(
            relay: RelayClient.builtInURL,
            signingKey: "c2lnbg==",
            encryptionKey: hostKey.publicKey.rawRepresentation.base64EncodedString(),
            keyId: PushCrypto.keyId(of: hostKey.publicKey.rawRepresentation)
        ))
        pairing.grant = PushPairing.Grant(id: "grant-1", expiresAt: .now.addingTimeInterval(86400 * 30), signingKey: "c2lnbg==")
        try store.save(pairing)
        self.pairing = pairing
    }

    /// `{ "hobwork": <envelope> }` as the relay puts it under `content-state` and `attributes`.
    func sealed(_ liveActivity: String, grant: String = "grant-1") throws -> Data {
        let plaintext = #"{"v":1,"sentAt":1700000000,"expiresAt":0,"aps":{},"hobwork":{"liveActivity":\#(liveActivity)}}"#
        let ciphertext = try TestSealer.seal(Data(plaintext.utf8), grant: grant, hostKey: hostKey, appKey: #require(pairing.agreementKey).publicKey)
        let envelope = JSONValue.object([
            "hobwork": .object([
                "v": .number(1), "grant": .string(grant), "keyId": .string(pairing.keys.keyId),
                "ciphertext": .string(ciphertext.base64EncodedString()),
            ]),
        ])
        return try JSONEncoder().encode(envelope)
    }

    func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.userInfo[.pushStore] = store
        return decoder
    }

    @Test func decodesAndEncodesPlainState() throws {
        let text = ##"{"title":"Oven","subtitle":"Bread","swatches":["#AA0000"],"icon":"oven","tint":"#FF8800","endsAt":1790841900,"startedAt":1790841600,"progress":0.5,"value":"220°","valueLabel":"heating","button":{"title":"Stop","opensApp":true},"open":"/oven","stillRunning":false}"##
        let state = try JSONDecoder().decode(LiveState.self, from: Data(text.utf8))
        #expect(state.title == "Oven")
        #expect(state.endDate == Date(timeIntervalSince1970: 1_790_841_900))
        #expect(state.button == LiveState.Action(title: "Stop", opensApp: true))
        #expect(state.open == "/oven")
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(state))
        #expect(encoded == json(text))
        #expect(try JSONDecoder().decode(LiveState.self, from: JSONEncoder().encode(state)) == state)
    }

    @Test func refusesPlainStateWithoutTitle() {
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(LiveState.self, from: Data(#"{"subtitle":"x"}"#.utf8)) }
    }

    @Test func opensSealedStateAndAttributes() throws {
        let data = try sealed(#"{"hob":"kitchen","id":"0b7c","state":{"title":"Oven","endsAt":1790841900}}"#)
        let state = try decoder().decode(LiveState.self, from: data)
        #expect(state == LiveState(title: "Oven", endsAt: 1_790_841_900))
        let attributes = try decoder().decode(HobworkActivityAttributes.self, from: data)
        #expect(attributes.hob == "kitchen")
        #expect(attributes.id == "0b7c")
        let plain = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(attributes))
        #expect(plain == json(#"{"hob":"kitchen","id":"0b7c"}"#))
    }

    @Test func showsThePlaceholderWhenTheStateDoesNotOpen() throws {
        let otherGrant = try sealed(#"{"hob":"kitchen","id":"0b7c","state":{"title":"Oven"}}"#, grant: "grant-2")
        #expect(try decoder().decode(LiveState.self, from: otherGrant) == .placeholder)
        #expect(try decoder().decode(HobworkActivityAttributes.self, from: otherGrant).hob == "")
        let noTitle = try sealed(#"{"hob":"kitchen","id":"0b7c","state":{"subtitle":"x"}}"#)
        #expect(try decoder().decode(LiveState.self, from: noTitle) == .placeholder)
        let garbage = Data(#"{"hobwork":{"v":1,"grant":"grant-1","keyId":"k","ciphertext":"AAAA"}}"#.utf8)
        #expect(try decoder().decode(LiveState.self, from: garbage) == .placeholder)
        #expect(LiveState.placeholder.subtitle == "Open Hobwork to see this.")
    }
}

@MainActor
struct LiveActivityCallTests {
    let system = FakeLiveActivitySystem()
    let now = Date(timeIntervalSince1970: 1_790_841_600)

    var activities: LiveActivities { LiveActivities(system: system, now: { [now] in now }) }

    @Test func startsWithTheHostsIDAndAnswersActivityKitsID() async throws {
        let value = try await activities.handle(method: "start", args: json(#"{"hob":"kitchen","id":"0b7c","state":{"title":"Oven"},"staleAt":1790845200,"relevance":50}"#))
        #expect(value == json(#"{"activity":"activity-1"}"#))
        let (attributes, content) = try #require(system.started.first)
        #expect(attributes.hob == "kitchen")
        #expect(attributes.id == "0b7c")
        #expect(content == LiveActivityContent(state: LiveState(title: "Oven"), staleDate: Date(timeIntervalSince1970: 1_790_845_200), relevance: 50))
    }

    @Test func endsActivitiesOfTheSameIDBeforeStartingAgain() async throws {
        system.running = ["0b7c"]
        _ = try await activities.handle(method: "start", args: json(#"{"hob":"kitchen","id":"0b7c","state":{"title":"Oven"}}"#))
        #expect(system.ended.map(\.0) == ["0b7c"])
        #expect(system.ended.map(\.2) == [.immediate])
        #expect(system.started.count == 1)
    }

    @Test func refusesWhenLiveActivitiesAreOff() async {
        system.areEnabled = false
        await #expect(throws: CallError.notAuthorized("Live Activities are turned off for Hobwork on this device")) {
            try await activities.handle(method: "start", args: json(#"{"hob":"kitchen","id":"0b7c","state":{"title":"Oven"}}"#))
        }
    }

    @Test func refusesBadArguments() async {
        await #expect(throws: CallError.self) { try await activities.handle(method: "start", args: json(#"{"hob":"kitchen","id":"0b7c","state":{}}"#)) }
        await #expect(throws: CallError.self) { try await activities.handle(method: "start", args: json(#"{"hob":"kitchen","state":{"title":"x"}}"#)) }
        await #expect(throws: CallError.self) { try await activities.handle(method: "update", args: json(#"{"id":"0b7c","state":{"title":"x"},"staleAt":"soon"}"#)) }
        await #expect(throws: CallError.unsupported("liveActivities", "pause")) { try await activities.handle(method: "pause", args: nil) }
    }

    @Test func updatesRunningActivities() async throws {
        system.running = ["0b7c"]
        #expect(try await activities.handle(method: "update", args: json(#"{"id":"0b7c","state":{"title":"Done"}}"#)) == json(#"{"updated":true}"#))
        #expect(try await activities.handle(method: "update", args: json(#"{"id":"other","state":{"title":"Done"}}"#)) == json(#"{"updated":false}"#))
        #expect(system.updated.first?.1.state.title == "Done")
    }

    @Test func endsWithTheDismissalPolicy() async throws {
        system.running = ["a", "b", "c"]
        #expect(try await activities.handle(method: "end", args: json(#"{"id":"a"}"#)) == json(#"{"ended":true}"#))
        _ = try await activities.handle(method: "end", args: json(#"{"id":"b","dismissAt":1790841500,"state":{"title":"Done"}}"#))
        _ = try await activities.handle(method: "end", args: json(#"{"id":"c","dismissAt":1790845200}"#))
        #expect(try await activities.handle(method: "end", args: json(#"{"id":"a"}"#)) == json(#"{"ended":false}"#))
        #expect(system.ended.map(\.2) == [.standard, .immediate, .after(Date(timeIntervalSince1970: 1_790_845_200)), .standard])
        #expect(system.ended[0].1 == nil)
        #expect(system.ended[1].1?.state.title == "Done")
    }

    @Test func reloadsWidgets() async throws {
        var reloads = 0
        let widgets = WidgetsCapability { reloads += 1 }
        #expect(try await widgets.handle(method: "reload", args: .object([:])) == .object([:]))
        #expect(reloads == 1)
    }
}

@MainActor
@Suite(.serialized)
struct LiveActivityTokenTests {
    let host = URL(string: "https://h.example.com")!
    let store = PushStore(items: MemoryItems())
    let transport = RecordingTransport()
    let memory = temporaryFile(StartTokenRecord?.none)
    let events = EventLog()

    @MainActor
    final class EventLog {
        var events: [DeviceEvent] = []
    }

    init() throws {
        try store.save(StoredRelayRegistration(id: "reg-1", secret: "s", token: "aa", environment: .sandbox, status: .active))
        var pairing = PushPairing(host: host, keys: HostPushKeys(relay: RelayClient.builtInURL, signingKey: "c2lnbg==", encryptionKey: "", keyId: "k"))
        pairing.grant = PushPairing.Grant(id: "grant-1", expiresAt: .now.addingTimeInterval(86400), signingKey: "c2lnbg==")
        try store.save(pairing)
        transport.status = 201
        transport.answer = json(#"{"id":"tok-1","expiresAt":null}"#)
    }

    func tokens() -> LiveActivityTokens {
        let events = events
        return LiveActivityTokens(
            relay: RelayClient(transport: transport), store: store, memory: memory,
            host: { [host] in host }, send: { events.events.append($0) }
        )
    }

    func body(_ request: URLRequest) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: #require(request.httpBody))
    }

    @Test func registersThePushToStartTokenOnce() async throws {
        await tokens().startTokenArrived(Data([0xAB, 0xCD]))
        let request = try #require(transport.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/v1/registrations/reg-1/grants/grant-1/activity-tokens")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer s")
        #expect(try body(request) == json(#"{"kind":"start","token":"abcd"}"#))
        #expect(events.events == [DeviceEvent(capability: "liveActivities", name: "startToken", data: json(#"{"token":"tok-1"}"#))])

        // The next launch gets the same token from ActivityKit.
        await tokens().startTokenArrived(Data([0xAB, 0xCD]))
        #expect(transport.requests.count == 1)
        #expect(events.events.count == 1)
    }

    @Test func registersAgainForANewGrant() async throws {
        let tokens = tokens()
        await tokens.startTokenArrived(Data([0xAB, 0xCD]))
        var pairing = try #require(store.pairing(for: host))
        pairing.grant?.id = "grant-2"
        try store.save(pairing)
        await tokens.reportStartToken()
        #expect(transport.requests.map { $0.url?.path } == [
            "/v1/registrations/reg-1/grants/grant-1/activity-tokens", "/v1/registrations/reg-1/grants/grant-2/activity-tokens",
        ])
        #expect(events.events.count == 2)
    }

    @Test func tellsTheHostWhenPushIsOff() async throws {
        let tokens = tokens()
        await tokens.startTokenArrived(Data([0xAB, 0xCD]))
        var pairing = try #require(store.pairing(for: host))
        pairing.grant = nil
        try store.save(pairing)
        await tokens.reportStartToken()
        #expect(events.events.last == DeviceEvent(capability: "liveActivities", name: "startToken", data: json(#"{"token":null}"#)))
        #expect(memory.read() == nil)
    }

    @Test func reportsActivityTokensAndEnds() async throws {
        let tokens = tokens()
        await tokens.activityTokenArrived(activity: "ak-1", id: "0b7c", token: Data([0x01]))
        #expect(try body(#require(transport.requests.first)) == json(#"{"kind":"update","token":"01"}"#))
        await tokens.activityChanged(activity: "ak-1", id: "0b7c", phase: .ended)
        #expect(events.events.map(\.data) == [
            json(#"{"id":"0b7c","activity":"ak-1","state":"active","token":"tok-1"}"#),
            json(#"{"id":"0b7c","activity":"ak-1","state":"ended","token":"tok-1"}"#),
        ])
        let delete = try #require(transport.requests.last)
        #expect(delete.httpMethod == "DELETE")
        #expect(delete.url?.path == "/v1/registrations/reg-1/grants/grant-1/activity-tokens/tok-1")
        await tokens.activityChanged(activity: "ak-1", id: "0b7c", phase: .dismissed)
        #expect(events.events.last?.data == json(#"{"id":"0b7c","activity":"ak-1","state":"dismissed"}"#))
        #expect(transport.requests.count == 2)
    }
}

@MainActor
struct LiveActivitiesBridgeTests {
    let policy = LinkPolicy(host: URL(string: "https://hobwork.example.com")!)
    let store = MemoryPermissionStore()
    let prompter = FakePrompter(answer: true)
    let presenter = FakePresenter()
    let system = FakeLiveActivitySystem()
    let asked = Asked()

    @MainActor
    final class Asked {
        var calls: [(String, String, String?, JSONValue)] = []
        var answer = json(#"{"id":"key-1","activity":{"id":"0b7c","hob":"filament","state":{"title":"Printing"},"staleAt":1790845200}}"#)
    }

    func router() -> BridgeRouter {
        let router = BridgeRouter(gatekeeper: BridgeGatekeeper(store: store, prompter: prompter)) { _, _ in true }
        let asked = asked
        router.register(LiveActivitiesBridge(activities: LiveActivities(system: system)) { hob, op, id, args in
            asked.calls.append((hob, op, id, args))
            return asked.answer
        })
        return router
    }

    func call(_ method: String, _ args: String = "null", host: String = "filament.apps.hobwork.example.com") async -> JSONValue {
        let origin = policy.hobOrigin(scheme: "https", host: host, port: nil)!
        let body = JSONValue.object(["capability": .string("liveActivities"), "method": .string(method), "args": json(args), "page": .string("p1")])
        return await router().handle(body: body, origin: origin, frame: Frame(), presenter: presenter)
    }

    @Test func answersStatus() async {
        system.frequentPushesEnabled = true
        #expect(await call("status")["value"] == json(#"{"enabled":true,"frequentPushes":true}"#))
        #expect(prompter.questions.isEmpty)
    }

    @Test func startsThroughTheHostThenHere() async throws {
        let reply = await call("start", #"{"title":"Printing","endsAt":"2026-10-09T12:00:00Z"}"#)
        #expect(reply["value"] == json(#"{"id":"key-1"}"#))
        let call = try #require(asked.calls.first)
        #expect(call.0 == "filament")
        #expect(call.1 == "start")
        #expect(call.2 == nil)
        #expect(call.3 == json(#"{"title":"Printing","endsAt":"2026-10-09T12:00:00Z"}"#))
        let (attributes, content) = try #require(system.started.first)
        #expect(attributes.hob == "filament")
        #expect(attributes.id == "0b7c")
        #expect(content.state.title == "Printing")
        #expect(content.staleDate == Date(timeIntervalSince1970: 1_790_845_200))
    }

    @Test func refusesBranchPreviewsAndTurnedOffActivities() async {
        let preview = await call("start", #"{"title":"x"}"#, host: "fix--filament.apps.hobwork.example.com")
        #expect(preview["error"]?["code"] == .string("unavailable"))
        system.areEnabled = false
        #expect(await call("start", #"{"title":"x"}"#)["error"]?["code"] == .string("denied"))
        #expect(asked.calls.isEmpty)
        #expect(system.started.isEmpty)
    }

    @Test func updatesAndEndsThroughTheHost() async throws {
        asked.answer = json(#"{"updated":true,"devices":2}"#)
        #expect(await call("update", #"{"id":"key-1","changes":{"subtitle":"Layer 3"}}"#)["value"] == asked.answer)
        asked.answer = json(#"{"ended":true,"devices":2}"#)
        #expect(await call("end", #"{"id":"key-1","dismissAt":"2026-10-09T12:00:00Z","content":{"title":"Done"}}"#)["value"] == asked.answer)
        #expect(asked.calls.map(\.1) == ["update", "end"])
        #expect(asked.calls.map(\.2) == ["key-1", "key-1"])
        #expect(asked.calls[0].3 == json(#"{"subtitle":"Layer 3"}"#))
        #expect(asked.calls[1].3 == json(#"{"content":{"title":"Done"},"dismissAt":"2026-10-09T12:00:00Z"}"#))
        #expect(system.started.isEmpty)
    }
}
