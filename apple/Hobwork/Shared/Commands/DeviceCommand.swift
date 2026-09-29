import Foundation

/// A call from the host, from the socket or from a push's `hobwork.command`.
struct DeviceCommand: Equatable, Sendable {
    var id: JSONValue
    var capability: String
    var method: String
    var args: JSONValue?
    var expiresAt: Date?
    /// Needs the app on screen (NFC). Pushes for these are tapped, not run by the extension.
    var foreground = false

    init(id: JSONValue, capability: String, method: String, args: JSONValue? = nil, expiresAt: Date? = nil, foreground: Bool = false) {
        self.id = id
        self.capability = capability
        self.method = method
        self.args = args
        self.expiresAt = expiresAt
        self.foreground = foreground
    }

    init(_ call: DeviceCall) {
        self.init(
            id: call.id,
            capability: call.capability,
            method: call.method,
            args: call.args,
            expiresAt: call.expiresAt.flatMap(ISODate.parse)
        )
    }

    /// The key commands are remembered by: the ID as sent, or its JSON for IDs that are
    /// not strings.
    var key: String {
        if let string = id.stringValue { return string }
        return (try? JSONEncoder().encode(id)).map { String(decoding: $0, as: UTF8.self) } ?? "\(id)"
    }

    var name: String { "\(capability).\(method)" }
}

/// A push that carries a command: `hobwork: { project, command: { id, capability, method,
/// args, expiresAt, foreground? } }`.
struct CommandPush: Equatable, Sendable {
    var project: String?
    var command: DeviceCommand

    init(project: String?, command: DeviceCommand) {
        self.project = project
        self.command = command
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let raw = userInfo[NotificationPayload.userInfoKey], let value = JSONValue(foundationValue: raw),
              let command = value["command"],
              let id = command["id"], id.stringValue != nil,
              let capability = command["capability"]?.stringValue,
              let method = command["method"]?.stringValue
        else { return nil }
        let foreground: Bool = if case .bool(true)? = command["foreground"] { true } else { false }
        self.init(
            project: value["project"]?.stringValue,
            command: DeviceCommand(
                id: id,
                capability: capability,
                method: method,
                args: command["args"],
                expiresAt: command["expiresAt"]?.stringValue.flatMap(ISODate.parse),
                foreground: foreground
            )
        )
    }
}
