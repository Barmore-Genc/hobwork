import Foundation

/// The text of the notification that a command push leaves behind. iOS always shows
/// command pushes, so it says what happened in a few words.
enum CommandSummary {
    static func text(
        for command: DeviceCommand,
        outcome: CommandOutcome,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let args = command.args
        func string(_ key: String) -> String? { args?[key]?.stringValue }
        func time(_ date: Date) -> String { format(date, now: now, calendar: calendar, locale: locale) }

        if case let .failure(error) = outcome.result {
            if error.code == "expired" { return "A request from Hobwork arrived too late and was skipped." }
            return "\(failureSubject(command)) failed: \(error.message)"
        }

        switch (command.capability, command.method) {
        case ("alarms", "set"):
            let title = string("title").map { " \u{201C}\($0)\u{201D}" } ?? ""
            if let at = string("at").flatMap(ISODate.parse) { return "Alarm\(title) set for \(time(at))" }
            let days = args?["days"]?.arrayValue?.compactMap(\.stringValue)
            let when = [string("time"), days.map { daysText($0) }].compactMap(\.self).joined(separator: " ")
            return "Alarm\(title) set for \(when)"
        case ("alarms", "timer"):
            let seconds = args?["seconds"]?.numberValue.map { Int($0) } ?? 0
            return "Timer set for \(duration(seconds))"
        case ("alarms", "cancel"):
            return "Alarm cancelled"
        case ("alarms", _):
            return "Alarms checked"
        case ("health", _):
            return "Health data read"
        case ("focus", _):
            return "Focus checked"
        default:
            return "Request from Hobwork done"
        }
    }

    private static func failureSubject(_ command: DeviceCommand) -> String {
        switch command.capability {
        case "alarms": command.method == "timer" ? "Timer" : "Alarm change"
        case "health": "Reading Health data"
        case "focus": "Checking Focus"
        default: "Request from Hobwork"
        }
    }

    /// `21:00` today, `Tue 21:00` within a week, a date after that.
    static func format(_ date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        style = style.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(style) }
        if date > now, date.timeIntervalSince(now) < 6 * 24 * 60 * 60 { return date.formatted(style.weekday(.abbreviated)) }
        return date.formatted(style.day().month(.abbreviated))
    }

    static func duration(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = seconds % 3600 / 60
        let rest = seconds % 60
        return [
            hours > 0 ? "\(hours) h" : nil,
            minutes > 0 ? "\(minutes) min" : nil,
            rest > 0 || seconds == 0 ? "\(rest) s" : nil,
        ].compactMap(\.self).joined(separator: " ")
    }

    private static func daysText(_ days: [String]) -> String {
        if Set(days) == ["mon", "tue", "wed", "thu", "fri"] { return "on weekdays" }
        if Set(days) == ["sat", "sun"] { return "on weekends" }
        return "on " + days.map(\.capitalized).joined(separator: ", ")
    }
}
