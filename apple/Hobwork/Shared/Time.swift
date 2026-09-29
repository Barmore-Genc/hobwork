import Foundation

/// A local time of day, `HH:MM` on the wire.
struct TimeOfDay: Codable, Hashable, Comparable, Sendable {
    var hour: Int
    var minute: Int

    init(hour: Int, minute: Int) {
        self.hour = hour
        self.minute = minute
    }

    init?(_ text: String) {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isASCII) }),
              let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0 ..< 24).contains(hour), (0 ..< 60).contains(minute)
        else { return nil }
        self.init(hour: hour, minute: minute)
    }

    var minutesSinceMidnight: Int { hour * 60 + minute }

    var text: String { String(format: "%02d:%02d", hour, minute) }

    var dateComponents: DateComponents { DateComponents(hour: hour, minute: minute) }

    static func < (lhs: TimeOfDay, rhs: TimeOfDay) -> Bool {
        lhs.minutesSinceMidnight < rhs.minutesSinceMidnight
    }

    init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let time = TimeOfDay(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not HH:MM: \(text)"))
        }
        self = time
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(text)
    }
}

enum Weekday: String, Codable, CaseIterable, Comparable, Sendable {
    case mon, tue, wed, thu, fri, sat, sun

    /// `Calendar`'s numbering: 1 is Sunday.
    var calendarWeekday: Int {
        switch self {
        case .sun: 1
        case .mon: 2
        case .tue: 3
        case .wed: 4
        case .thu: 5
        case .fri: 6
        case .sat: 7
        }
    }

    init?(calendarWeekday: Int) {
        guard let day = Weekday.allCases.first(where: { $0.calendarWeekday == calendarWeekday }) else { return nil }
        self = day
    }

    var next: Weekday {
        Weekday(calendarWeekday: calendarWeekday % 7 + 1)!
    }

    var localeWeekday: Locale.Weekday {
        switch self {
        case .mon: .monday
        case .tue: .tuesday
        case .wed: .wednesday
        case .thu: .thursday
        case .fri: .friday
        case .sat: .saturday
        case .sun: .sunday
        }
    }

    private var order: Int { Weekday.allCases.firstIndex(of: self)! }

    static func < (lhs: Weekday, rhs: Weekday) -> Bool {
        lhs.order < rhs.order
    }
}

enum ISODate {
    /// Accepts ISO 8601 date-times with an offset or `Z`, with or without fractions of a second.
    static func parse(_ text: String) -> Date? {
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        return try? Date(text, strategy: Date.ISO8601FormatStyle())
    }

    static func format(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle())
    }
}
