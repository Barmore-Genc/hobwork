import Foundation

@MainActor
final class HomeKitCapability: CapabilityHandler {
    nonisolated static let capability = "homekit"
    private let bridge: HomeKitBridge
    private let approve: (String, String) async -> Bool

    init(store: any HomeKitStore, approve: @escaping (String, String) async -> Bool) {
        bridge = HomeKitBridge(store: store)
        self.approve = approve
    }

    static func approvalMessage(for method: String) -> String {
        switch method {
        case "homes": "It wants to read the homes in Apple Home."
        case "accessories": "It wants to read the accessories in your Home."
        case "services": "It wants to see the controls and sensors on a Home accessory."
        case "get": "It wants to read a Home accessory's current value."
        case "set": "It wants to change a Home accessory's value."
        case "assignRoom": "It wants to move a Home accessory to another room."
        case "rename": "It wants to rename a Home accessory."
        default: "It wants to use your Home."
        }
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        guard bridge.methods.contains(method) else { throw CallError.badRequest("homekit has no \(method)") }
        let arguments = try Arguments(args, call: "homekit.\(method)")
        let hob = try arguments.nonEmptyString("hob")
        // A connected socket can deliver commands without a notification tap. Approval
        // must happen here too, before HomeKit can read or change anything.
        guard await approve(hob, method) else { throw CallError(code: "denied", message: "Home access was not approved") }
        do {
            return try await bridge.execute(method, args: args ?? .null)
        } catch {
            throw CallError(code: error.reason ?? error.code.rawValue, message: error.message)
        }
    }
}
