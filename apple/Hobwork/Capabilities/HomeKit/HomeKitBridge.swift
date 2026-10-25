import Foundation

extension HomeKitHome {
    var json: JSONValue {
        .object(["id": .string(id), "name": .string(name), "primary": .bool(isPrimary)])
    }
}

extension HomeKitAccessory {
    var json: JSONValue {
        .object([
            "id": .string(id),
            "name": .string(name),
            "room": room.map(JSONValue.string) ?? .null,
            "serialNumber": serialNumber.map(JSONValue.string) ?? .null,
            "bridge": bridge.map(JSONValue.string) ?? .null,
        ])
    }
}

/// `homekit.homes`, `accessories`, `assignRoom` and `rename`. HomeKit has no rooms in its
/// protocol, so a bridged accessory lands in the default room and only an app with the
/// HomeKit entitlement can move it. Reading and changing each ask the person once per hob.
@MainActor
final class HomeKitBridge: BridgeCapability {
    let name = "homekit"
    let methods = ["homes", "accessories", "assignRoom", "rename"]
    private let store: any HomeKitStore

    /// HomeKit's own limit on names is not published; this only stops absurd input.
    static let longestName = 255

    init(store: any HomeKitStore) {
        self.store = store
    }

    func permission(for method: String) -> BridgePermission? {
        switch method {
        case "homes", "accessories":
            BridgePermission(
                key: "homekit.read",
                label: "Read your Home",
                title: { "Let “\($0)” see your Home?" },
                message: "It can then read the names and rooms of your homes and accessories."
            )
        case "assignRoom", "rename":
            BridgePermission(
                key: "homekit.write",
                label: "Change rooms and names in Home",
                title: { "Let “\($0)” change your Home?" },
                message: "It can then move accessories to other rooms and rename them."
            )
        default:
            nil
        }
    }

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        switch method {
        case "homes":
            return .array(try await store.homes().map(\.json))
        case "accessories":
            let home = try args.requiredString("home")
            return .array(try await store.accessories(home: home).map(\.json))
        case "assignRoom":
            let accessory = try args.requiredString("accessory")
            let room = try Self.cleaned(args, "room")
            try await store.assignRoom(accessory: accessory, room: room)
            return .null
        case "rename":
            let accessory = try args.requiredString("accessory")
            let name = try Self.cleaned(args, "name")
            try await store.rename(accessory: accessory, name: name)
            return .null
        default:
            throw BridgeError.failed("homekit has no \(method)")
        }
    }

    /// A name or room without the spaces around it, never empty, never absurdly long.
    static func cleaned(_ args: JSONValue, _ key: String) throws(BridgeError) -> String {
        let value = try args.requiredString(key).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw .failed("\(key) is required") }
        guard value.count <= longestName else { throw .failed("\(key) is longer than \(longestName) characters") }
        return value
    }
}
