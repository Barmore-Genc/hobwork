import AlarmKit
import Foundation

/// A row on the alarms screen.
struct AlarmItem: Identifiable, Equatable {
    enum Kind: Equatable {
        case alarm, timer
    }

    enum Status: Equatable {
        case scheduled
        /// `endsAt` is nil while the Live Activity has not reported the countdown.
        case running(endsAt: Date?)
        case paused(remaining: TimeInterval?)
        case ringing
    }

    enum Action: Equatable {
        case pause, resume, stop, cancel
    }

    enum When: Equatable {
        case at(Date)
        /// Once at the next occurrence when `days` is nil.
        case time(TimeOfDay, days: [Weekday]?)
    }

    /// A timer's countdown as its Live Activity shows it, which is the only place AlarmKit
    /// tells the app when a timer ends.
    enum Progress: Equatable {
        case running(fireDate: Date)
        case paused(remaining: TimeInterval)

        init?(_ mode: AlarmPresentationState.Mode) {
            switch mode {
            case let .countdown(countdown): self = .running(fireDate: countdown.fireDate)
            case let .paused(paused): self = .paused(remaining: paused.totalCountdownDuration - paused.previouslyElapsedDuration)
            default: return nil
            }
        }
    }

    var id: UUID
    var title: String
    var kind: Kind
    var status: Status
    var when: When?
    var duration: TimeInterval?

    init(id: UUID, title: String, kind: Kind, status: Status, when: When? = nil, duration: TimeInterval? = nil) {
        self.id = id
        self.title = title
        self.kind = kind
        self.status = status
        self.when = when
        self.duration = duration
    }

    init(id: UUID, state: AlarmState, schedule: Alarm.Schedule?, duration: TimeInterval?, title: String?, progress: Progress?, now: Date) {
        let kind: Kind = schedule == nil ? .timer : .alarm
        let title = title.flatMap { $0.isEmpty ? nil : $0 } ?? (kind == .timer ? "Timer" : "Alarm")
        self.init(
            id: id,
            title: title,
            kind: kind,
            status: Self.status(state, progress: progress, now: now),
            when: schedule.map(Self.when),
            duration: duration
        )
    }

    /// AlarmKit can report a pause or resume before the Live Activity does, so the activity's
    /// countdown is read in the light of the alarm's own state.
    static func status(_ state: AlarmState, progress: Progress?, now: Date) -> Status {
        switch state {
        case .scheduled:
            return .scheduled
        case .alerting:
            return .ringing
        case .countdown:
            switch progress {
            case let .running(fireDate): return .running(endsAt: fireDate)
            case let .paused(remaining): return .running(endsAt: now.addingTimeInterval(remaining))
            case nil: return .running(endsAt: nil)
            }
        case .paused:
            switch progress {
            case let .running(fireDate): return .paused(remaining: max(0, fireDate.timeIntervalSince(now)))
            case let .paused(remaining): return .paused(remaining: remaining)
            case nil: return .paused(remaining: nil)
            }
        }
    }

    static func when(_ schedule: Alarm.Schedule) -> When {
        switch schedule {
        case let .fixed(date):
            return .at(date)
        case let .relative(relative):
            let time = TimeOfDay(hour: relative.time.hour, minute: relative.time.minute)
            switch relative.repeats {
            case let .weekly(days):
                let days = Weekday.allCases.filter { day in days.contains(day.localeWeekday) }
                return .time(time, days: days.isEmpty ? nil : days)
            default:
                return .time(time, days: nil)
            }
        @unknown default:
            return .time(TimeOfDay(hour: 0, minute: 0), days: nil)
        }
    }

    var actions: [Action] {
        switch status {
        case .scheduled: [.cancel]
        case .running: [.pause, .cancel]
        case .paused: [.resume, .cancel]
        case .ringing: [.stop]
        }
    }

    var kindText: String {
        kind == .timer ? "Timer" : "Alarm"
    }

    var stateText: String {
        switch status {
        case .scheduled: "Scheduled"
        case .running: "Running"
        case .paused: "Paused"
        case .ringing: "Ringing"
        }
    }

    /// When an alarm rings, or how long a paused or not yet reported timer has. Running timers
    /// with an end show a live countdown instead.
    func detailText(calendar: Calendar = .autoupdatingCurrent) -> String? {
        let locale = calendar.locale ?? .autoupdatingCurrent
        switch (kind, status) {
        case (.timer, let .paused(remaining?)):
            return "\(Self.durationText(remaining)) left"
        case (.timer, .running(endsAt: nil)), (.timer, .paused(remaining: nil)), (.timer, .scheduled):
            return duration.map(Self.durationText)
        case (.timer, _):
            return nil
        case (.alarm, _):
            switch when {
            case let .at(date):
                let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                    .weekday(.abbreviated).day().month(.abbreviated).hour().minute()
                return "Rings \(date.formatted(style))"
            case let .time(time, days):
                let text = Self.timeText(time, calendar: calendar)
                guard let days else { return "Rings at \(text)" }
                return "\(text), \(Self.daysText(days, calendar: calendar))"
            case nil:
                return nil
            }
        }
    }

    static func durationText(_ seconds: TimeInterval) -> String {
        let seconds = max(0, seconds.rounded())
        let pattern: Duration.TimeFormatStyle.Pattern = seconds >= 3600 ? .hourMinuteSecond : .minuteSecond
        return Duration.seconds(seconds).formatted(.time(pattern: pattern))
    }

    static func timeText(_ time: TimeOfDay, calendar: Calendar) -> String {
        var components = time.dateComponents
        components.year = 2001
        components.month = 1
        components.day = 1
        guard let date = calendar.date(from: components) else { return time.text }
        let style = Date.FormatStyle(locale: calendar.locale ?? .autoupdatingCurrent, calendar: calendar, timeZone: calendar.timeZone)
            .hour().minute()
        return date.formatted(style)
    }

    static func daysText(_ days: [Weekday], calendar: Calendar) -> String {
        let days = Set(days)
        if days.count == 7 { return "every day" }
        if days == [.mon, .tue, .wed, .thu, .fri] { return "weekdays" }
        if days == [.sat, .sun] { return "weekends" }
        let names = Weekday.allCases.filter(days.contains).map { calendar.shortWeekdaySymbols[$0.calendarWeekday - 1] }
        return names.joined(separator: ", ")
    }

    /// Ringing first, then timers, then alarms.
    static func sorted(_ items: [AlarmItem]) -> [AlarmItem] {
        items.sorted { lhs, rhs in
            if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
            return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
        }
    }

    private var rank: Int {
        switch status {
        case .ringing: 0
        case .running, .paused: 1
        case .scheduled: kind == .timer ? 1 : 2
        }
    }
}
