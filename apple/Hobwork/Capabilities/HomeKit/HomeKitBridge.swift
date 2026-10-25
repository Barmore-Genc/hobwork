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

/// Native Home access. Accessory control has a separate grant from room and name changes,
/// so an existing room-sync grant cannot start controlling devices.
@MainActor
final class HomeKitBridge: BridgeCapability {
    let name = "homekit"
    let methods = ["homes", "accessories", "assignRoom", "rename", "services", "get", "set"]
    private let store: any HomeKitStore

    /// HomeKit's own limit on names is not published; this only stops absurd input.
    static let longestName = 255

    init(store: any HomeKitStore) {
        self.store = store
    }

    func permission(for method: String) -> BridgePermission? {
        switch method {
        case "homes", "accessories", "services", "get":
            BridgePermission(
                key: "homekit.read",
                label: "Read your Home",
                title: { "Let “\($0)” see your Home?" },
                message: "It can then read your homes, accessories, and their current values."
            )
        case "assignRoom", "rename":
            BridgePermission(
                key: "homekit.write",
                label: "Change rooms and names in Home",
                title: { "Let “\($0)” change your Home?" },
                message: "It can then move accessories to other rooms and rename them."
            )
        case "set":
            BridgePermission(
                key: "homekit.control",
                label: "Control Home accessories",
                title: { "Let “\($0)” control your Home accessories?" },
                message: "It can change accessory values, such as power, brightness, and temperature."
            )
        default:
            nil
        }
    }

    func call(_ method: String, args: JSONValue, context _: BridgeContext) async throws -> JSONValue {
        try await execute(method, args: args)
    }

    func execute(_ method: String, args: JSONValue) async throws(BridgeError) -> JSONValue {
        switch method {
        case "homes":
            return .array(try await store.homes().map(\.json))
        case "accessories":
            let home = try args.requiredString("home")
            return .array(try await store.accessories(home: home).map(\.json))
        case "services":
            return .array(try await store.services(accessory: args.requiredString("accessory")).map(\.json))
        case "get":
            return try await store.get(accessory: args.requiredString("accessory"), characteristic: args.requiredString("characteristic"))
        case "set":
            let accessory = try args.requiredString("accessory")
            let characteristic = try args.requiredString("characteristic")
            guard let value = args["value"] else { throw .failed("value is required") }
            switch value {
            case .bool, .string: break
            case let .number(number) where number.isFinite: break
            default: throw .failed("value must be a string, finite number, or boolean")
            }
            try await store.set(accessory: accessory, characteristic: characteristic, value: value)
            return .null
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
