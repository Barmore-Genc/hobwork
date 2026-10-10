import Foundation

/// `app.info`: which app, device and person a hob page runs for.
@MainActor
final class AppInfoBridge: BridgeCapability {
    struct Person: Equatable, Sendable {
        var id: Int
        var name: String
    }

    let name = "app"
    let methods = ["info"]
    private let deviceName: () -> String?
    private let person: () async -> Person?

    /// `deviceName` is the name hobs use for this device, `person` its owner on the host.
    init(deviceName: @escaping () -> String?, person: @escaping () async -> Person?) {
        self.deviceName = deviceName
        self.person = person
    }

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        let person = await person()
        return .object([
            "platform": .string(Hello.platform),
            "appVersion": .string(AppModel.appVersion),
            "bridgeVersion": .number(Double(BridgeRouter.version)),
            "hob": .string(context.origin.hob),
            "branch": context.origin.branch.map(JSONValue.string) ?? .null,
            "device": deviceName().map { .object(["name": .string($0)]) } ?? .null,
            "person": person.map { .object(["id": .number(Double($0.id)), "name": .string($0.name)]) } ?? .null,
        ])
    }
}
