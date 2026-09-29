import Foundation

/// An alarm or timer Hobwork made. AlarmKit does not return titles, so they are kept here.
struct AlarmRecord: Codable, Equatable, Sendable {
    /// As the handler sent it, or a new lowercase UUID.
    var id: String
    var title: String
    var at: Date?
    var time: TimeOfDay?
    var days: [Weekday]?
    var seconds: Int?

    var uuid: UUID? { UUID(uuidString: id) }

    func json(state: AlarmState) -> JSONValue {
        var object: [String: JSONValue] = ["id": .string(id), "title": .string(title), "state": .string(state.rawValue)]
        if let at { object["at"] = .string(ISODate.format(at)) }
        if let time { object["time"] = .string(time.text) }
        if let days { object["days"] = .array(days.map { .string($0.rawValue) }) }
        if let seconds { object["seconds"] = .number(Double(seconds)) }
        return .object(object)
    }
}

enum AlarmState: String, Sendable {
    case scheduled, countdown, paused, alerting
}

enum AlarmSchedulingError: Error, Equatable {
    case notAuthorized
    case limitReached
}

/// AlarmKit, behind a protocol for tests.
@MainActor
protocol AlarmScheduling: AnyObject {
    var isAuthorized: Bool { get }
    func schedule(_ alarm: AlarmRecord) async throws
    func cancel(_ id: UUID)
    func alarms() throws -> [(id: UUID, state: AlarmState)]
}

/// The `alarms` capability.
@MainActor
final class AlarmsCapability: CapabilityHandler {
    nonisolated static let capability = "alarms"
    static let maxTimerSeconds = 24 * 60 * 60

    private let scheduler: any AlarmScheduling
    private let records: SharedFile<[AlarmRecord]>
    private let now: () -> Date

    init(
        scheduler: any AlarmScheduling,
        records: SharedFile<[AlarmRecord]> = SharedFile(name: "alarms.json", empty: []),
        now: @escaping () -> Date = { Date() }
    ) {
        self.scheduler = scheduler
        self.records = records
        self.now = now
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        let call = "alarms.\(method)"
        switch method {
        case "set": return try await schedule(Self.alarm(from: Arguments(args, call: call), now: now()))
        case "timer": return try await schedule(Self.timer(from: Arguments(args, call: call)))
        case "cancel": return try cancel(Arguments(args, call: call))
        case "list": return try list()
        default: throw CallError.unsupported(Self.capability, method)
        }
    }

    static func alarm(from args: Arguments, now: Date) throws(CallError) -> AlarmRecord {
        let title = try args.nonEmptyString("title")
        let id = try alarmID(args)
        let at = try args.optionalDate("at")
        let time = try args.optionalTime("time")
        let days = try args.optionalDays("days")
        switch (at, time) {
        case let (at?, nil):
            guard days == nil else { throw .badRequest("days only works with time") }
            guard at > now else { throw .badRequest("at is in the past") }
            return AlarmRecord(id: id, title: title, at: at)
        case let (nil, time?):
            return AlarmRecord(id: id, title: title, time: time, days: days)
        default:
            throw .badRequest("alarms.set needs exactly one of at (a date-time) or time (HH:MM)")
        }
    }

    static func timer(from args: Arguments) throws(CallError) -> AlarmRecord {
        let title = try args.nonEmptyString("title")
        let seconds = try args.int("seconds", in: 1 ... maxTimerSeconds)
        return try AlarmRecord(id: alarmID(args), title: title, seconds: seconds)
    }

    private static func alarmID(_ args: Arguments) throws(CallError) -> String {
        guard let id = try args.optionalString("id") else { return UUID().uuidString.lowercased() }
        guard UUID(uuidString: id) != nil else { throw .badRequest("id must be a UUID") }
        return id
    }

    private func requireAuthorization() throws(CallError) {
        guard scheduler.isAuthorized else {
            throw .notAuthorized("Alarms are not allowed for Hobwork on this device. Allow them in the Hobwork app's settings.")
        }
    }

    private func schedule(_ alarm: AlarmRecord) async throws -> JSONValue {
        try requireAuthorization()
        guard let uuid = alarm.uuid else { throw CallError.badRequest("id must be a UUID") }
        // Scheduling a known ID again replaces that alarm.
        scheduler.cancel(uuid)
        do {
            try await scheduler.schedule(alarm)
        } catch AlarmSchedulingError.limitReached {
            throw CallError(code: "limit_reached", message: "This device has as many alarms from Hobwork as iOS allows")
        } catch AlarmSchedulingError.notAuthorized {
            throw CallError.notAuthorized("Alarms are not allowed for Hobwork on this device")
        }
        records.update { records in
            records.removeAll { $0.uuid == uuid }
            records.append(alarm)
        }
        return .object(["id": .string(alarm.id)])
    }

    private func cancel(_ args: Arguments) throws -> JSONValue {
        let id = try args.string("id")
        if let uuid = UUID(uuidString: id) {
            scheduler.cancel(uuid)
            records.update { $0.removeAll { $0.uuid == uuid } }
        }
        return .object([:])
    }

    private func list() throws -> JSONValue {
        try requireAuthorization()
        let alarms = try scheduler.alarms()
        let live = Set(alarms.map(\.id))
        let records = records.update { records in
            records.removeAll { record in record.uuid.map { !live.contains($0) } ?? true }
            return records
        }
        return .array(alarms.map { alarm in
            let record = records.first { $0.uuid == alarm.id }
                ?? AlarmRecord(id: alarm.id.uuidString.lowercased(), title: "")
            return record.json(state: alarm.state)
        })
    }
}
