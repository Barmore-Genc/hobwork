#if os(iOS)
    import Foundation

    /// `alarms` for hob pages: the `alarms` device capability on this device, limited to the
    /// page's hob. Setting, changing and cancelling ask the person once per hob; iOS asks once
    /// for Hobwork the first time.
    @MainActor
    final class AlarmsBridge: BridgeCapability {
        let name = "alarms"
        let methods = ["set", "timer", "reschedule", "cancel", "list"]
        private let capability: AlarmsCapability
        private let authorize: () async -> Bool

        init(capability: AlarmsCapability, authorize: @escaping () async -> Bool) {
            self.capability = capability
            self.authorize = authorize
        }

        func permission(for method: String) -> BridgePermission? {
            guard method != "list" else { return nil }
            return BridgePermission(
                key: "alarms",
                label: "Set alarms and timers",
                title: { "Let “\($0)” set alarms and timers?" },
                message: "They ring on this \(DeviceModel.name) even in silent mode and Focus."
            )
        }

        func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
            let hob = context.origin.hob
            guard await authorize() else {
                throw BridgeError.denied("Alarms are turned off for Hobwork. Turn them on in the Settings app.")
            }
            var object = args.objectValue ?? [:]
            // Hobs only see and change their own alarms.
            if method != "list", let id = try args.string("id") {
                let owner = capability.record(id)?.hob
                if method == "cancel", owner != hob { return .null }
                if method == "reschedule", owner != hob {
                    throw BridgeError.failed("This hob has no timer with this ID", reason: "unknown_alarm")
                }
                if let owner, owner != hob { throw BridgeError.failed("Another hob set the alarm with this ID") }
            }
            if method == "list" { return try await run { try capability.list(hob: hob) } }
            object["hob"] = .string(hob)
            let value = try await run { try await capability.handle(method: method, args: .object(object)) }
            return method == "cancel" ? .null : value
        }

        private func run(_ body: () async throws -> JSONValue) async throws -> JSONValue {
            do {
                return try await body()
            } catch let error as CallError {
                switch error.code {
                case "not_authorized": throw BridgeError.denied(error.message)
                case "bad_request": throw BridgeError.failed(error.message)
                default: throw BridgeError.failed(error.message, reason: error.code)
                }
            }
        }
    }
#endif
