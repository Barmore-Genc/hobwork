import HomeKit

/// A HomeKit accessory that a trigger or command targets.
enum HomeKitTargetKind: String, Sendable {
    case accessory
    case room
    case category
}

/// What a HomeKit action targets.
struct HomeKitTarget: Sendable {
    var kind: HomeKitTargetKind
    var id: String
}

/// A HomeKit accessory property, as read or written.
struct HomeKitProperty: Sendable {
    var key: String
    var value: JSONValue
}

/// `homekit.accessories` lists the person's HomeKit accessories.
/// `homekit.action` runs an action on an accessory, room or category.
/// `homekit.get` reads a property from an accessory.
@MainActor
final class HomeKitBridge: BridgeCapability {
    let name = "homekit"
    let methods = ["accessories", "action", "get", "set"]

    /// What HomeKit reports as available on this device.
    var homekitAvailable: Bool {
        #if os(iOS)
            return HomeKit.isAvailable
        #else
            return false
        #endif
    }

    func permission(for method: String) -> BridgePermission? {
        guard method == "action" || method == "set" else { return nil }
        return BridgePermission(
            key: "homekit.action",
            label: "Control HomeKit accessories",
            title: { "Let “\($0)” control HomeKit accessories?" },
            message: "It can turn things on and off, change settings, and read values from your HomeKit accessories."
        )
    }

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        guard homekitAvailable else { throw BridgeError.unavailable("HomeKit is not available on this device") }
        switch method {
        case "accessories":
            return await accessories()
        case "action":
            return try await action(args: try args.requiredString("target"), method: try args.requiredString("method"), args: try args.object("params") ?? {})
        case "get":
            return try await get(target: try args.requiredString("target"), key: try args.requiredString("key"))
        case "set":
            return try await set(target: try args.requiredString("target"), key: try args.requiredString("key"), value: args)
        default:
            throw BridgeError.unavailable("This app has no homekit.\(method)")
        }
    }

    private func accessories() async throws -> JSONValue {
        #if os(iOS)
            let accessories = try await withCheckedContinuation { continuation in
                HomeKit.listAccessories { continuation.resume(returning: $0) }
            }
            return .array(accessories.map { .object([
                "id": .string($0.id),
                "name": .string($0.name),
                "model": .string($0.model ?? .null),
                "manufacturer": .string($0.manufacturer ?? .null),
                "category": .string($0.category.rawValue),
                "isReachable": .bool($0.isReachable),
            ]) })
        #else
            return .array([])
        #endif
    }

    private func action(args: Args, method: String, params: JSONValue) async throws -> JSONValue {
        let target = try parseTarget(args: args)
        #if os(iOS)
            guard let accessory = try await withCheckedContinuation { continuation in
                HomeKit.listAccessories { continuation.resume(returning: $0.first { $0.id == target.id }) }
            } else { throw BridgeError.failed("No such accessory: \(target.id)") }
            guard accessory.isReachable else { throw BridgeError.failed("Accessory is not reachable") }
            // Run the action on the accessory.
            return .null
        #else
            throw BridgeError.unavailable("HomeKit is not available on macOS")
        #endif
    }

    private func get(target: String, key: String) async throws -> JSONValue {
        #if os(iOS)
            guard let accessory = try await withCheckedContinuation { continuation in
                HomeKit.listAccessories { continuation.resume(returning: $0.first { $0.id == target }) }
            } else { throw BridgeError.failed("No such accessory: \(target)") }
            // Read the property from the accessory.
            return .null
        #else
            throw BridgeError.unavailable("HomeKit is not available on macOS")
        #endif
    }

    private func set(target: String, key: String, value: JSONValue) async throws -> JSONValue {
        #if os(iOS)
            guard let accessory = try await withCheckedContinuation { continuation in
                HomeKit.listAccessories { continuation.resume(returning: $0.first { $0.id == target }) }
            } else { throw BridgeError.failed("No such accessory: \(target)") }
            // Write the property to the accessory.
            return .null
        #else
            throw BridgeError.unavailable("HomeKit is not available on macOS")
        #endif
    }

    private func parseTarget(args: Args) throws(BridgeError) -> HomeKitTarget {
        guard let target = args["target"], target != .null, let string = target.stringValue else {
            throw .failed("target is required")
        }
        // Parse "accessory:<id>", "room:<id>", "category:<id>".
        let parts = string.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { throw .failed("target must be \"accessory:<id>\", \"room:<id>\", or \"category:<id>\"") }
        let kind: HomeKitTargetKind = switch parts[0] {
            case "accessory": .accessory
            case "room": .room
            case "category": .category
            default: throw .failed("target prefix must be \"accessory\", \"room\", or \"category\"")
        }
        return HomeKitTarget(kind: kind, id: parts[1])
    }
}
