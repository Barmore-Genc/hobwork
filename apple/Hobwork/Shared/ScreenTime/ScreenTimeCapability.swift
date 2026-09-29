import Foundation

/// The `screenTime` capability.
@MainActor
final class ScreenTimeCapability: CapabilityHandler {
    nonisolated static let capability = "screenTime"

    private let isAuthorized: () -> Bool
    private let shields: any ShieldControlling
    private let monitoring: any ActivityMonitoring
    private let file: SharedFile<ScreenTimeState>
    private let now: () -> Date
    private let calendar: Calendar

    init(
        isAuthorized: @escaping () -> Bool = { ScreenTimeAuthorization.isApproved },
        shields: any ShieldControlling = ManagedSettingsShields(),
        monitoring: any ActivityMonitoring = DeviceActivityMonitoring(),
        file: SharedFile<ScreenTimeState> = ScreenTimeState.file,
        now: @escaping () -> Date = { Date() },
        calendar: Calendar = .current
    ) {
        self.isAuthorized = isAuthorized
        self.shields = shields
        self.monitoring = monitoring
        self.file = file
        self.now = now
        self.calendar = calendar
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        guard isAuthorized() else {
            throw CallError.notAuthorized("Screen Time is not allowed for Hobwork on this device. Allow it in the Hobwork app's settings.")
        }
        let args = try Arguments(args, call: "screenTime.\(method)")
        switch method {
        case "sets": return sets()
        case "block": return try block(args)
        case "unblock": return try unblock(args)
        case "schedule": return try schedule(args)
        case "removeSchedule": return try removeSchedule(args)
        case "limit": return try limit(args)
        case "removeLimit": return try removeLimit(args)
        case "status": return status()
        default: throw CallError.unsupported(Self.capability, method)
        }
    }

    private func sets() -> JSONValue {
        .array(file.read().sets.map { set in
            .object([
                "name": .string(set.name),
                "apps": .number(Double(set.apps)),
                "categories": .number(Double(set.categories)),
                "sites": .number(Double(set.sites)),
            ])
        })
    }

    private func appSet(_ args: Arguments) throws -> AppSet {
        let name = try args.string("set")
        guard let set = file.read().set(named: name) else {
            throw CallError(code: "unknown_set", message: "There is no app set named \(name) on this device. Create it in the Hobwork app's settings.")
        }
        return set
    }

    private func block(_ args: Arguments) throws -> JSONValue {
        let set = try appSet(args)
        let until = try args.optionalDate("until")
        let name = ActivityName.block(set: set.name)
        if let until {
            let activity: PlannedActivity
            do {
                activity = try ScreenTimePlan.block(set: set.name, until: until, now: now(), calendar: calendar)
            } catch {
                throw CallError.badRequest("until is in the past")
            }
            try start([activity], selection: nil)
        } else {
            monitoring.stop([name.rawValue])
        }
        shields.shield(store: name.store, selection: set.selection)
        file.update { state in
            state.blocks.removeAll { $0.set == set.name }
            state.blocks.append(ScreenTimeBlock(set: set.name, until: until))
        }
        return .object([:])
    }

    private func unblock(_ args: Arguments) throws -> JSONValue {
        let name = try args.string("set")
        let state = file.read()
        guard state.set(named: name) != nil || state.blocks.contains(where: { $0.set == name }) else {
            throw CallError(code: "unknown_set", message: "There is no app set named \(name) on this device")
        }
        let activity = ActivityName.block(set: name)
        monitoring.stop([activity.rawValue])
        shields.clear(store: activity.store)
        file.update { $0.blocks.removeAll { $0.set == name } }
        return .object([:])
    }

    private func schedule(_ args: Arguments) throws -> JSONValue {
        let name = try args.slug("name")
        let set = try appSet(args)
        let schedule = try ScreenTimeSchedule(
            name: name,
            set: set.name,
            start: args.time("start"),
            end: args.time("end"),
            days: args.optionalDays("days")
        )
        let activities: [PlannedActivity]
        do {
            activities = try ScreenTimePlan.activities(for: schedule)
        } catch {
            throw CallError(code: "interval_too_short", message: "Screen Time schedules must be at least \(ScreenTimePlan.minimumMinutes) minutes long")
        }
        let store = ActivityName.schedule(name: name, day: nil).store
        stopActivities(prefix: "schedule.\(name)")
        shields.clear(store: store)
        try start(activities, selection: nil)
        if ScreenTimePlan.isActive(schedule, at: now(), calendar: calendar) {
            shields.shield(store: store, selection: set.selection)
        }
        file.update { state in
            state.schedules.removeAll { $0.name == name }
            state.schedules.append(schedule)
        }
        return .object([:])
    }

    private func removeSchedule(_ args: Arguments) throws -> JSONValue {
        let name = try args.string("name")
        stopActivities(prefix: "schedule.\(name)")
        shields.clear(store: ActivityName.schedule(name: name, day: nil).store)
        file.update { $0.schedules.removeAll { $0.name == name } }
        return .object([:])
    }

    private func limit(_ args: Arguments) throws -> JSONValue {
        let name = try args.slug("name")
        let set = try appSet(args)
        let limit = try ScreenTimeLimit(
            name: name,
            set: set.name,
            minutes: args.int("minutes", in: 1 ... 24 * 60 - 1),
            days: args.optionalDays("days")
        )
        stopActivities(prefix: "limit.\(name)")
        shields.clear(store: ActivityName.limit(name: name, day: nil).store)
        try start(ScreenTimePlan.activities(for: limit), selection: set.selection)
        file.update { state in
            state.limits.removeAll { $0.name == name }
            state.limits.append(limit)
        }
        return .object([:])
    }

    private func removeLimit(_ args: Arguments) throws -> JSONValue {
        let name = try args.string("name")
        stopActivities(prefix: "limit.\(name)")
        shields.clear(store: ActivityName.limit(name: name, day: nil).store)
        file.update { $0.limits.removeAll { $0.name == name } }
        return .object([:])
    }

    private func status() -> JSONValue {
        let now = now()
        let today = ScreenTimeState.day(of: now, calendar: calendar)
        let state = file.update { state in
            state.blocks.removeAll { block in block.until.map { $0 <= now } ?? false }
            return state
        }
        return .object([
            "blocked": .array(state.blocks.map { block in
                var object: [String: JSONValue] = ["set": .string(block.set)]
                if let until = block.until { object["until"] = .string(ISODate.format(until)) }
                return .object(object)
            }),
            "schedules": .array(state.schedules.map { schedule in
                var object: [String: JSONValue] = [
                    "name": .string(schedule.name),
                    "set": .string(schedule.set),
                    "start": .string(schedule.start.text),
                    "end": .string(schedule.end.text),
                ]
                if let days = schedule.days { object["days"] = .array(days.map { .string($0.rawValue) }) }
                return .object(object)
            }),
            "limits": .array(state.limits.map { limit in
                var object: [String: JSONValue] = [
                    "name": .string(limit.name),
                    "set": .string(limit.set),
                    "minutes": .number(Double(limit.minutes)),
                    "reached": .bool(limit.reachedOn == today),
                ]
                if let days = limit.days { object["days"] = .array(days.map { .string($0.rawValue) }) }
                return .object(object)
            }),
        ])
    }

    /// `schedule.<name>` and `schedule.<name>.<day>`, not `schedule.<name>-other`.
    private func stopActivities(prefix: String) {
        monitoring.stop(monitoring.activities.filter { $0 == prefix || $0.hasPrefix(prefix + ".") })
    }

    private func start(_ activities: [PlannedActivity], selection: Data?) throws {
        var started: [String] = []
        for activity in activities {
            do {
                try monitoring.start(activity, selection: selection)
                started.append(activity.name.rawValue)
            } catch {
                monitoring.stop(started)
                throw Self.callError(error)
            }
        }
    }

    private static func callError(_ error: ActivityMonitoringError) -> CallError {
        switch error {
        case .intervalTooShort:
            CallError(code: "interval_too_short", message: "Screen Time intervals must be at least \(ScreenTimePlan.minimumMinutes) minutes long")
        case .intervalTooLong:
            CallError.badRequest("The interval is longer than Screen Time allows")
        case .tooManyActivities:
            CallError(code: "limit_reached", message: "This device has as many Screen Time schedules and limits as iOS allows")
        case .unauthorized:
            CallError.notAuthorized("Screen Time is not allowed for Hobwork on this device")
        case .invalid:
            CallError(code: "failed", message: "Screen Time did not accept the schedule")
        }
    }
}
