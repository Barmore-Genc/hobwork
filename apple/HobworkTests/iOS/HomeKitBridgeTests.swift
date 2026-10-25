import Foundation
import Testing
@testable import Hobwork

@MainActor
struct HomeKitBridgeTests {
    let policy = LinkPolicy(host: URL(string: "https://hobwork.example.com")!)
    let permissions = MemoryPermissionStore()
    let prompter = FakePrompter(answer: true)
    let presenter = FakePresenter()
    let home = FakeHomeKitStore()

    var filament: HobOrigin { policy.hobOrigin(scheme: "https", host: "filament.apps.hobwork.example.com", port: nil)! }

    func router() -> BridgeRouter {
        let router = BridgeRouter(gatekeeper: BridgeGatekeeper(store: permissions, prompter: prompter), deliver: { _, _ in true })
        router.register(HomeKitBridge(store: home))
        return router
    }

    func call(_ router: BridgeRouter, _ method: String, _ args: JSONValue = .null) async -> JSONValue {
        let body: JSONValue = .object(["capability": .string("homekit"), "method": .string(method), "args": args, "page": .string("p1")])
        return await router.handle(body: body, origin: filament, frame: Frame(), presenter: presenter)
    }

    func args(_ pairs: KeyValuePairs<String, String>) -> JSONValue {
        .object(Dictionary(uniqueKeysWithValues: pairs.map { ($0.key, JSONValue.string($0.value)) }))
    }

    func errorCode(_ reply: JSONValue) -> String? { reply["error"]?["code"]?.stringValue }
    func errorMessage(_ reply: JSONValue) -> String? { reply["error"]?["message"]?.stringValue }

    // MARK: What it offers

    @Test func offersTheSupportedMethods() {
        #expect(router().manifest == ["homekit": ["accessories", "assignRoom", "get", "homes", "rename", "services", "set"]])
    }

    // MARK: Reading

    @Test func listsTheHomes() async {
        home.homesList = [
            HomeKitHome(id: "H1", name: "Our House", isPrimary: true),
            HomeKitHome(id: "H2", name: "Cabin", isPrimary: false),
        ]
        let reply = await call(router(), "homes")
        #expect(reply["ok"] == .bool(true))
        #expect(reply["value"] == .array([
            .object(["id": .string("H1"), "name": .string("Our House"), "primary": .bool(true)]),
            .object(["id": .string("H2"), "name": .string("Cabin"), "primary": .bool(false)]),
        ]))
    }

    @Test func listsAHomesAccessoriesWithRoomSerialAndBridge() async {
        let reply = await call(router(), "accessories", args(["home": "H1"]))
        #expect(home.accessoryQueries == ["H1"])
        #expect(reply["value"] == .array([
            .object([
                "id": .string("A1"), "name": .string("Lamp"), "room": .string("Default Room"),
                "serialNumber": .string("light.lamp"), "bridge": .string("HASS Bridge"),
            ]),
            .object(["id": .string("A2"), "name": .string("Hue Bridge"), "room": .null, "serialNumber": .null, "bridge": .null]),
        ]))
    }

    @Test func accessoriesNeedsAHome() async {
        let reply = await call(router(), "accessories", .object([:]))
        #expect(errorCode(reply) == "failed")
        #expect(errorMessage(reply) == "home is required")
        #expect(home.accessoryQueries.isEmpty)
    }

    @Test func discoversServicesAndReadsACharacteristic() async {
        let router = router()
        let reply = await call(router, "services", args(["accessory": "A1"]))
        #expect(home.serviceQueries == ["A1"])
        #expect(reply["value"]?.arrayValue?.first?["characteristics"]?.arrayValue?.first == home.characteristic.json)
        let value = await call(router, "get", args(["accessory": "A1", "characteristic": "C1"]))
        #expect(value["value"] == .bool(true))
        #expect(home.reads.map(\.characteristic) == ["C1"])
        #expect(prompter.questions.count == 1)
    }

    @Test func controlNeedsItsOwnGrantEvenAfterRenaming() async {
        let router = router()
        _ = await call(router, "rename", args(["accessory": "A1", "name": "Lux"]))
        prompter.answer = false
        let reply = await call(router, "set", .object(["accessory": .string("A1"), "characteristic": .string("C1"), "value": .bool(false)]))
        #expect(errorCode(reply) == "denied")
        #expect(home.writes.isEmpty)
        #expect(permissions.all[filament.permissionKey]?["homekit.write"] == true)
        #expect(permissions.all[filament.permissionKey]?["homekit.control"] == false)
    }

    @Test func writesTheRequestedValueNotTheArgumentObject() async {
        let reply = await call(router(), "set", .object(["accessory": .string("A1"), "characteristic": .string("C1"), "value": .bool(false)]))
        #expect(reply["ok"] == .bool(true))
        #expect(home.writes.count == 1)
        #expect(home.writes.first?.accessory == "A1")
        #expect(home.writes.first?.characteristic == "C1")
        #expect(home.writes.first?.value == .bool(false))
    }

    @Test(arguments: [JSONValue.null, .array([]), .object([:])])
    func rejectsNonScalarWrites(value: JSONValue) async {
        let reply = await call(router(), "set", .object(["accessory": .string("A1"), "characteristic": .string("C1"), "value": value]))
        #expect(errorCode(reply) == "failed")
        #expect(home.writes.isEmpty)
    }

    @Test func refusesMissingCharacteristic() async {
        let reply = await call(router(), "get", args(["accessory": "A1"]))
        #expect(errorCode(reply) == "failed")
        #expect(home.reads.isEmpty)
    }

    // MARK: Changing

    @Test func movesAnAccessoryToARoomWithoutTheSpacesAroundIt() async {
        let reply = await call(router(), "assignRoom", args(["accessory": "A1", "room": "  Laundry room \n"]))
        #expect(reply["ok"] == .bool(true))
        #expect(home.assigned.map(\.accessory) == ["A1"])
        #expect(home.assigned.map(\.room) == ["Laundry room"])
    }

    @Test func renamesAnAccessoryWithoutTheSpacesAroundTheName() async {
        let reply = await call(router(), "rename", args(["accessory": "A1", "name": " Lux "]))
        #expect(reply["ok"] == .bool(true))
        #expect(home.renamed.map(\.accessory) == ["A1"])
        #expect(home.renamed.map(\.name) == ["Lux"])
    }

    @Test(arguments: [
        ("assignRoom", ["accessory": "A1"], "room is required"),
        ("assignRoom", ["accessory": "A1", "room": "   "], "room is required"),
        ("assignRoom", ["room": "Lair"], "accessory is required"),
        ("assignRoom", ["accessory": "", "room": "Lair"], "accessory is required"),
        ("rename", ["accessory": "A1"], "name is required"),
        ("rename", ["accessory": "A1", "name": "\n\t"], "name is required"),
        ("rename", ["name": "Lux"], "accessory is required"),
    ])
    func refusesChangesThatAreMissingSomething(method: String, pairs: [String: String], message: String) async {
        let reply = await call(router(), method, .object(pairs.mapValues { JSONValue.string($0) }))
        #expect(errorCode(reply) == "failed")
        #expect(errorMessage(reply) == message)
        #expect(home.assigned.isEmpty && home.renamed.isEmpty)
    }

    @Test func refusesAbsurdlyLongNames() async {
        let long = String(repeating: "x", count: HomeKitBridge.longestName + 1)
        #expect(errorCode(await call(router(), "rename", args(["accessory": "A1", "name": long]))) == "failed")
        #expect(errorCode(await call(router(), "assignRoom", args(["accessory": "A1", "room": long]))) == "failed")
        let longest = String(repeating: "x", count: HomeKitBridge.longestName)
        #expect(await call(router(), "rename", args(["accessory": "A1", "name": longest]))["ok"] == .bool(true))
        #expect(home.assigned.isEmpty && home.renamed.count == 1)
    }

    @Test func passesTheStoresErrorsAndReasonsThrough() async {
        home.failure = .failed("There is no accessory with that ID", reason: "unknown_accessory")
        let reply = await call(router(), "rename", args(["accessory": "nope", "name": "Lux"]))
        #expect(errorCode(reply) == "failed")
        #expect(reply["error"]?["reason"] == .string("unknown_accessory"))

        home.failure = BridgeError(code: .denied, message: "Allow Hobwork to use Home in Settings", reason: "not_authorized")
        let denied = await call(router(), "homes")
        #expect(errorCode(denied) == "denied")
        #expect(denied["error"]?["reason"] == .string("not_authorized"))
    }

    // MARK: Permissions

    @Test func asksToReadAndToChangeSeparately_andRemembersEach() async {
        let router = router()
        #expect(await call(router, "homes")["ok"] == .bool(true))
        #expect(await call(router, "accessories", args(["home": "H1"]))["ok"] == .bool(true))
        #expect(prompter.questions == ["Let “filament” see your Home?"])

        #expect(await call(router, "rename", args(["accessory": "A1", "name": "Lux"]))["ok"] == .bool(true))
        #expect(await call(router, "assignRoom", args(["accessory": "A1", "room": "Lair"]))["ok"] == .bool(true))
        #expect(prompter.questions == ["Let “filament” see your Home?", "Let “filament” change your Home?"])
        #expect(permissions.all == [filament.permissionKey: ["homekit.read": true, "homekit.write": true]])
    }

    @Test func aNoToChangingStopsChangesButNotReading() async {
        let router = router()
        prompter.answer = false
        let renamed = await call(router, "rename", args(["accessory": "A1", "name": "Lux"]))
        let moved = await call(router, "assignRoom", args(["accessory": "A1", "room": "Lair"]))
        #expect(errorCode(renamed) == "denied")
        #expect(errorCode(moved) == "denied")
        #expect(home.renamed.isEmpty && home.assigned.isEmpty)

        prompter.answer = true
        #expect(await call(router, "homes")["ok"] == .bool(true))
        // The earlier no for changing is remembered, so it does not ask again and still refuses.
        #expect(errorCode(await call(router, "rename", args(["accessory": "A1", "name": "Lux"]))) == "denied")
        #expect(home.renamed.isEmpty)
    }

    @Test func aNoToReadingStopsReading() async {
        let router = router()
        prompter.answer = false
        #expect(errorCode(await call(router, "homes")) == "denied")
        #expect(errorCode(await call(router, "accessories", args(["home": "H1"]))) == "denied")
        #expect(home.accessoryQueries.isEmpty)
    }

    @Test func eachMethodAsksTheRightQuestion() {
        let bridge = HomeKitBridge(store: home)
        #expect(bridge.permission(for: "homes")?.key == "homekit.read")
        #expect(bridge.permission(for: "accessories")?.key == "homekit.read")
        #expect(bridge.permission(for: "assignRoom")?.key == "homekit.write")
        #expect(bridge.permission(for: "rename")?.key == "homekit.write")
        #expect(bridge.permission(for: "services")?.key == "homekit.read")
        #expect(bridge.permission(for: "get")?.key == "homekit.read")
        #expect(bridge.permission(for: "set")?.key == "homekit.control")
        #expect(bridge.permission(for: "shout") == nil)
    }
}
