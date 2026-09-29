import Foundation

/// A DeviceActivity schedule to monitor, without DeviceActivity types so it can be tested.
struct PlannedActivity: Equatable, Sendable {
    var name: ActivityName
    var start: DateComponents
    var end: DateComponents
    var repeats: Bool
    /// For limits: shield `set` after this much use in the interval.
    var threshold: DateComponents?
    var set: String?
}

/// Activity names carry what the monitor extension has to do when iOS calls it.
enum ActivityName: Hashable, Sendable {
    case block(set: String)
    case schedule(name: String, day: Weekday?)
    case limit(name: String, day: Weekday?)

    var rawValue: String {
        switch self {
        case let .block(set): "block.\(set)"
        case let .schedule(name, day): ["schedule", name, day?.rawValue].compactMap(\.self).joined(separator: ".")
        case let .limit(name, day): ["limit", name, day?.rawValue].compactMap(\.self).joined(separator: ".")
        }
    }

    init?(rawValue: String) {
        let parts = rawValue.split(separator: ".").map(String.init)
        guard parts.count >= 2, parts.count <= 3 else { return nil }
        let day = parts.count == 3 ? Weekday(rawValue: parts[2]) : nil
        if parts.count == 3, day == nil { return nil }
        switch parts[0] {
        case "block" where parts.count == 2: self = .block(set: parts[1])
        case "schedule": self = .schedule(name: parts[1], day: day)
        case "limit": self = .limit(name: parts[1], day: day)
        default: return nil
        }
    }

    /// The ManagedSettings store this activity shields with. Timed blocks use the set's
    /// own store, the one `block` and `unblock` use.
    var store: String {
        switch self {
        case let .block(set): set
        case let .schedule(name, _): "schedule.\(name)"
        case let .limit(name, _): "limit.\(name)"
        }
    }
}

enum ScreenTimePlanError: Error, Equatable {
    case intervalTooShort
    case untilInThePast
}

enum MonitorEvent: Sendable {
    case intervalStart
    case intervalEnd
    case threshold
}

enum MonitorAction: Equatable, Sendable {
    case shield(store: String, set: String)
    case clear(store: String)
    case endBlock(set: String)
    case limitReached(name: String)
    case resetLimit(name: String)
}

enum ScreenTimePlan {
    /// DeviceActivity refuses shorter intervals.
    static let minimumMinutes = 15

    static func block(set: String, until: Date, now: Date, calendar: Calendar = .current) throws(ScreenTimePlanError) -> PlannedActivity {
        guard until > now else { throw .untilInThePast }
        let start = min(now, until.addingTimeInterval(-Double(minimumMinutes * 60)))
        let fields: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]
        return PlannedActivity(
            name: .block(set: set),
            start: calendar.dateComponents(fields, from: start),
            end: calendar.dateComponents(fields, from: until),
            repeats: false
        )
    }

    /// Minutes from start to end, across midnight when end is earlier.
    static func length(from start: TimeOfDay, to end: TimeOfDay) -> Int {
        (end.minutesSinceMidnight - start.minutesSinceMidnight + 24 * 60) % (24 * 60)
    }

    static func activities(for schedule: ScreenTimeSchedule) throws(ScreenTimePlanError) -> [PlannedActivity] {
        guard length(from: schedule.start, to: schedule.end) >= minimumMinutes else { throw .intervalTooShort }
        guard let days = schedule.days else {
            return [PlannedActivity(
                name: .schedule(name: schedule.name, day: nil),
                start: schedule.start.dateComponents,
                end: schedule.end.dateComponents,
                repeats: true
            )]
        }
        let overnight = schedule.end <= schedule.start
        return days.map { day in
            var start = schedule.start.dateComponents
            start.weekday = day.calendarWeekday
            var end = schedule.end.dateComponents
            end.weekday = (overnight ? day.next : day).calendarWeekday
            return PlannedActivity(name: .schedule(name: schedule.name, day: day), start: start, end: end, repeats: true)
        }
    }

    /// A daily 00:00 to 23:59 interval whose event fires after `minutes` of use.
    static func activities(for limit: ScreenTimeLimit) -> [PlannedActivity] {
        let days: [Weekday?] = limit.days ?? [nil]
        return days.map { day in
            var start = DateComponents(hour: 0, minute: 0)
            var end = DateComponents(hour: 23, minute: 59)
            start.weekday = day?.calendarWeekday
            end.weekday = day?.calendarWeekday
            return PlannedActivity(
                name: .limit(name: limit.name, day: day),
                start: start,
                end: end,
                repeats: true,
                threshold: DateComponents(minute: limit.minutes),
                set: limit.set
            )
        }
    }

    static func isActive(_ schedule: ScreenTimeSchedule, at date: Date, calendar: Calendar = .current) -> Bool {
        let components = calendar.dateComponents([.weekday, .hour, .minute], from: date)
        guard let weekday = components.weekday.flatMap(Weekday.init(calendarWeekday:)) else { return false }
        let minute = (components.hour ?? 0) * 60 + (components.minute ?? 0)
        let start = schedule.start.minutesSinceMidnight
        let end = schedule.end.minutesSinceMidnight
        func on(_ day: Weekday) -> Bool { schedule.days?.contains(day) ?? true }
        if start < end { return on(weekday) && minute >= start && minute < end }
        let yesterday = Weekday(calendarWeekday: (weekday.calendarWeekday + 5) % 7 + 1)!
        return (on(weekday) && minute >= start) || (on(yesterday) && minute < end)
    }

    /// What the monitor extension does when iOS calls it for an activity.
    static func actions(for event: MonitorEvent, activity rawName: String, state: ScreenTimeState) -> [MonitorAction] {
        guard let name = ActivityName(rawValue: rawName) else { return [] }
        switch (name, event) {
        case let (.block(set), .intervalEnd):
            return [.clear(store: name.store), .endBlock(set: set)]
        case (.block, _):
            return []
        case let (.schedule(scheduleName, _), .intervalStart):
            guard let schedule = state.schedules.first(where: { $0.name == scheduleName }) else { return [] }
            return [.shield(store: name.store, set: schedule.set)]
        case (.schedule, .intervalEnd):
            return [.clear(store: name.store)]
        case (.schedule, .threshold):
            return []
        case let (.limit(limitName, _), .threshold):
            guard let limit = state.limits.first(where: { $0.name == limitName }) else { return [] }
            return [.shield(store: name.store, set: limit.set), .limitReached(name: limitName)]
        case let (.limit(limitName, _), _):
            return [.clear(store: name.store), .resetLimit(name: limitName)]
        }
    }

    /// Carries out monitor actions: shields through `shields`, bookkeeping in `state`.
    static func perform(_ actions: [MonitorAction], shields: any ShieldControlling, state: inout ScreenTimeState, now: Date, calendar: Calendar = .current) {
        for action in actions {
            switch action {
            case let .shield(store, set):
                if let set = state.set(named: set) { shields.shield(store: store, selection: set.selection) }
            case let .clear(store):
                shields.clear(store: store)
            case let .endBlock(set):
                state.blocks.removeAll { $0.set == set && $0.until != nil }
            case let .limitReached(name):
                if let index = state.limits.firstIndex(where: { $0.name == name }) {
                    state.limits[index].reachedOn = ScreenTimeState.day(of: now, calendar: calendar)
                }
            case let .resetLimit(name):
                if let index = state.limits.firstIndex(where: { $0.name == name }) { state.limits[index].reachedOn = nil }
            }
        }
    }
}

/// ManagedSettings stores, behind a protocol for tests.
protocol ShieldControlling {
    func shield(store: String, selection: Data)
    func clear(store: String)
}

enum ActivityMonitoringError: Error, Equatable {
    case intervalTooShort
    case intervalTooLong
    case tooManyActivities
    case unauthorized
    case invalid
}

/// DeviceActivityCenter, behind a protocol for tests.
protocol ActivityMonitoring {
    var activities: [String] { get }
    func start(_ activity: PlannedActivity, selection: Data?) throws(ActivityMonitoringError)
    func stop(_ names: [String])
}
