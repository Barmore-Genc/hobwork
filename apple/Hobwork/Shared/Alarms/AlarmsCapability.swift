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
    var subtitle: String?
    /// `#RRGGBB`.
    var tint: String?
    /// The ringing timer's second button: a new countdown of this many seconds.
    var repeatSeconds: Int?
    var repeatTitle: String?
    /// The hob that set it, which gets its events.
    var hob: String?

    init(
        id: String, title: String, at: Date? = nil, time: TimeOfDay? = nil, days: [Weekday]? = nil, seconds: Int? = nil,
        subtitle: String? = nil, tint: String? = nil, repeatSeconds: Int? = nil, repeatTitle: String? = nil, hob: String? = nil
    ) {
        self.id = id
        self.title = title
        self.at = at
        self.time = time
        self.days = days
        self.seconds = seconds
        self.subtitle = subtitle
        self.tint = tint
        self.repeatSeconds = repeatSeconds
        self.repeatTitle = repeatTitle
        self.hob = hob
    }

    var uuid: UUID? { UUID(uuidString: id) }

    /// The repeat button's text: the hob's, or the interval such as "+2 h" or "+15 min".
    var repeatLabel: String? {
        guard let repeatSeconds else { return nil }
        return repeatTitle ?? Self.interval(repeatSeconds)
    }

    static func interval(_ seconds: Int) -> String {
        let hours = seconds / 3600, minutes = seconds % 3600 / 60, rest = seconds % 60
        if seconds < 60 { return "+\(seconds) s" }
        if hours == 0 { return rest == 0 ? "+\(minutes) min" : "+\(minutes) min \(rest) s" }
        return minutes == 0 ? "+\(hours) h" : "+\(hours) h \(minutes) min"
    }

    func json(state: AlarmState, endsAt: Date? = nil) -> JSONValue {
        var object: [String: JSONValue] = ["id": .string(id), "title": .string(title), "state": .string(state.rawValue)]
        if let at { object["at"] = .string(ISODate.format(at)) }
        if let time { object["time"] = .string(time.text) }
        if let days { object["days"] = .array(days.map { .string($0.rawValue) }) }
        if let seconds { object["seconds"] = .number(Double(seconds)) }
        if let subtitle { object["subtitle"] = .string(subtitle) }
        if let tint { object["tint"] = .string(tint) }
        if let repeatSeconds {
            var button: [String: JSONValue] = ["seconds": .number(Double(repeatSeconds))]
            if let repeatTitle { button["title"] = .string(repeatTitle) }
            object["repeat"] = .object(button)
        }
        if let endsAt, state == .countdown { object["endsAt"] = .string(ISODate.format(endsAt)) }
        return .object(object)
    }
}

enum AlarmState: String, Sendable {
    case scheduled, countdown, paused, alerting
}

/// An alarm AlarmKit has, with when a running timer rings when its Live Activity says so.
struct ScheduledAlarm: Equatable, Sendable {
    var id: UUID
    var state: AlarmState
    var endsAt: Date?
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
    func alarms() throws -> [ScheduledAlarm]
}

/// The `alarms` capability.
@MainActor
final class AlarmsCapability: CapabilityHandler {
    nonisolated static let capability = "alarms"
    static let maxTimerSeconds = 24 * 60 * 60
    nonisolated static let recordsFile = SharedFile<[AlarmRecord]>(name: "alarms.json", empty: [])

    private let scheduler: any AlarmScheduling
    private let records: SharedFile<[AlarmRecord]>
    private let now: () -> Date

    init(
        scheduler: any AlarmScheduling,
        records: SharedFile<[AlarmRecord]> = AlarmsCapability.recordsFile,
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
        case "reschedule": return try await reschedule(Arguments(args, call: call))
        case "cancel": return try cancel(Arguments(args, call: call))
        case "list": return try list()
        default: throw CallError.unsupported(Self.capability, method)
        }
    }

    /// The hob's alarms only, for the web bridge.
    func list(hob: String) throws -> JSONValue {
        let all = try list()
        let ids = Set(records.read().filter { $0.hob == hob }.map(\.id))
        return .array((all.arrayValue ?? []).filter { $0["id"]?.stringValue.map(ids.contains) ?? false })
    }

    func record(_ id: String) -> AlarmRecord? {
        guard let uuid = UUID(uuidString: id) else { return nil }
        return records.read().first { $0.uuid == uuid }
    }

    static func alarm(from args: Arguments, now: Date) throws(CallError) -> AlarmRecord {
        let title = try args.nonEmptyString("title")
        let id = try alarmID(args)
        let at = try args.optionalDate("at")
        let time = try args.optionalTime("time")
        let days = try args.optionalDays("days")
        var record: AlarmRecord
        switch (at, time) {
        case let (at?, nil):
            guard days == nil else { throw .badRequest("days only works with time") }
            guard at > now else { throw .badRequest("at is in the past") }
            record = AlarmRecord(id: id, title: title, at: at)
        case let (nil, time?):
            record = AlarmRecord(id: id, title: title, time: time, days: days)
        default:
            throw .badRequest("alarms.set needs exactly one of at (a date-time) or time (HH:MM)")
        }
        try applyLooks(args, to: &record)
        return record
    }

    static func timer(from args: Arguments) throws(CallError) -> AlarmRecord {
        let title = try args.nonEmptyString("title")
        let seconds = try args.int("seconds", in: 1 ... maxTimerSeconds)
        var record = try AlarmRecord(id: alarmID(args), title: title, seconds: seconds)
        try applyLooks(args, to: &record)
        try applyRepeat(args, to: &record, allowNull: false)
        return record
    }

    private static func applyLooks(_ args: Arguments, to record: inout AlarmRecord) throws(CallError) {
        if args.has("subtitle") { record.subtitle = try args.nonEmptyString("subtitle") }
        if args.has("tint") { record.tint = try tint(args.string("tint")) }
        if args.has("hob") { record.hob = try args.string("hob") }
    }

    private static func applyRepeat(_ args: Arguments, to record: inout AlarmRecord, allowNull: Bool) throws(CallError) {
        guard args.has("repeat") else {
            if allowNull, case .null? = args.raw("repeat") {
                record.repeatSeconds = nil
                record.repeatTitle = nil
            }
            return
        }
        let button = try Arguments(args.raw("repeat"), call: "repeat")
        record.repeatSeconds = try button.int("seconds", in: 1 ... maxTimerSeconds)
        record.repeatTitle = button.has("title") ? try button.nonEmptyString("title", maxLength: 20) : nil
    }

    static func tint(_ text: String) throws(CallError) -> String {
        let hex = text.uppercased()
        guard hex.count == 7, hex.first == "#", hex.dropFirst().allSatisfy({ $0.isHexDigit }) else {
            throw .badRequest("tint must be a color like #FF9500")
        }
        return hex
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

    /// A timer again under its ID: the new time, or what was left, with the changed button and text.
    private func reschedule(_ args: Arguments) async throws -> JSONValue {
        try requireAuthorization()
        let id = try args.string("id")
        let live = try scheduler.alarms().first { $0.id == UUID(uuidString: id) }
        guard var record = record(id), record.seconds != nil, let live else {
            throw CallError(code: "unknown_alarm", message: "This device has no timer with this ID. It may have been stopped.")
        }
        if args.has("title") { record.title = try args.nonEmptyString("title") }
        try Self.applyLooks(args, to: &record)
        try Self.applyRepeat(args, to: &record, allowNull: true)
        if let seconds = try args.optionalInt("seconds", in: 1 ... Self.maxTimerSeconds) {
            record.seconds = seconds
        } else if let endsAt = live.endsAt {
            record.seconds = max(1, Int(endsAt.timeIntervalSince(now()).rounded()))
        }
        return try await schedule(record)
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
            return record.json(state: alarm.state, endsAt: alarm.endsAt)
        })
    }
}
