#if os(iOS)
    import Foundation

    /// `liveActivities` for hob pages. The host owns each activity, so it reaches the hob's
    /// other devices and push updates: `start` asks the host first, then starts the activity
    /// here while the page is on screen.
    @MainActor
    final class LiveActivitiesBridge: BridgeCapability {
        /// `POST /api/devices/live-activities` for the page's hob.
        typealias Host = (_ hob: String, _ op: String, _ id: String?, _ args: JSONValue) async throws -> JSONValue

        let name = "liveActivities"
        let methods = ["start", "update", "end", "status"]
        private let activities: LiveActivities
        private let host: Host

        init(activities: LiveActivities, host: @escaping Host) {
            self.activities = activities
            self.host = host
        }

        func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
            let hob = context.origin.hob
            switch method {
            case "status":
                return .object([
                    "enabled": .bool(activities.system.areEnabled),
                    "frequentPushes": .bool(activities.system.frequentPushesEnabled),
                ])
            case "start":
                guard context.origin.branch == nil else {
                    throw BridgeError.unavailable("Live Activities can't be started from a branch preview")
                }
                guard activities.system.areEnabled else {
                    throw BridgeError.denied("Live Activities are turned off for Hobwork. Turn them on in the Settings app.")
                }
                let answer = try await ask(hob, "start", nil, args)
                guard let key = answer["id"]?.stringValue, let activity = answer["activity"] else {
                    throw BridgeError.failed("The host sent an answer this app does not understand")
                }
                do {
                    _ = try await activities.start(activity)
                } catch let error as CallError {
                    throw error.code == "not_authorized" ? BridgeError.denied(error.message) : BridgeError.failed(error.message)
                }
                return .object(["id": .string(key)])
            case "update":
                let id = try args.requiredString("id")
                return try await ask(hob, "update", id, args["changes"] ?? .object([:]))
            default:
                let id = try args.requiredString("id")
                var end: [String: JSONValue] = [:]
                if let content = args["content"], content != .null { end["content"] = content }
                if let dismissAt = args["dismissAt"], dismissAt != .null { end["dismissAt"] = dismissAt }
                return try await ask(hob, "end", id, .object(end))
            }
        }

        private func ask(_ hob: String, _ op: String, _ id: String?, _ args: JSONValue) async throws -> JSONValue {
            do {
                return try await host(hob, op, id, args)
            } catch let error as HostError {
                throw BridgeError.failed(error.errorDescription ?? "The host refused")
            }
        }
    }
#endif
