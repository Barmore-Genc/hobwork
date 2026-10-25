import Foundation
import Testing
@testable import Hobwork

@MainActor
struct HomeKitCapabilityTests {
    @Test func remoteReadNeedsApproval() async throws {
        let store = FakeHomeKitStore()
        var requests: [String] = []
        let capability = HomeKitCapability(store: store) { hob, method in
            requests.append("\(hob).\(method)")
            return false
        }
        await #expect(throws: CallError(code: "denied", message: "Home access was not approved")) {
            try await capability.handle(method: "homes", args: .object(["hob": .string("filament")]))
        }
        #expect(requests == ["filament.homes"])
        #expect(store.accessoryQueries.isEmpty)
    }

    @Test func approvedCommandsUseTheSameStoreAndValidation() async throws {
        let store = FakeHomeKitStore()
        let capability = HomeKitCapability(store: store) { _, _ in true }
        let result = try await capability.handle(method: "get", args: .object([
            "hob": .string("filament"), "accessory": .string("A1"), "characteristic": .string("C1"),
        ]))
        #expect(result == .bool(true))
        #expect(store.reads.first?.characteristic == "C1")
        store.failure = .failed("Accessory is not reachable", reason: "unreachable")
        await #expect(throws: CallError(code: "unreachable", message: "Accessory is not reachable")) {
            try await capability.handle(method: "homes", args: .object(["hob": .string("filament")]))
        }
    }

    @Test func missingProvenanceDoesNotAskOrRun() async {
        let store = FakeHomeKitStore()
        var asked = false
        let capability = HomeKitCapability(store: store) { _, _ in asked = true; return true }
        await #expect(throws: CallError.self) {
            try await capability.handle(method: "homes", args: .object([:]))
        }
        #expect(!asked)
    }

    @Test func checksCharacteristicFormatRangeAndStep() throws {
        var characteristic = HomeKitCharacteristic(id: "C1", type: "brightness", readable: true, writable: true, format: "int", min: 0, max: 100, step: 5)
        try characteristic.validate(.number(50))
        for value in [JSONValue.number(-1), .number(101), .number(1.5), .number(51), .number(.infinity), .bool(true), .null] {
            #expect(throws: BridgeError.self) { try characteristic.validate(value) }
        }
        characteristic.writable = false
        #expect(throws: BridgeError.self) { try characteristic.validate(.number(50)) }
    }
}
