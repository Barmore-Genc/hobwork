import Foundation

@MainActor
protocol CapabilityHandler: AnyObject {
    /// Throw a `CallError` to send its code to the host; other errors become `failed`.
    func handle(method: String, args: JSONValue?) async throws -> JSONValue
}

/// A call's `args` object, with getters that answer `bad_request` for missing or
/// mistyped values.
struct Arguments {
    let call: String
    private let values: [String: JSONValue]

    init(_ args: JSONValue?, call: String) throws(CallError) {
        self.call = call
        switch args {
        case nil, .null?: values = [:]
        case let .object(object)?: values = object
        default: throw .badRequest("\(call) takes an object")
        }
    }

    func has(_ key: String) -> Bool {
        if case nil = values[key] { return false }
        return values[key] != .null
    }

    /// The value as sent, `.null` included.
    func raw(_ key: String) -> JSONValue? {
        values[key]
    }

    func string(_ key: String) throws(CallError) -> String {
        guard let value = try optionalString(key) else { throw .badRequest("\(call) needs \(key)") }
        return value
    }

    func optionalString(_ key: String) throws(CallError) -> String? {
        guard has(key) else { return nil }
        guard let value = values[key]?.stringValue else { throw .badRequest("\(key) must be a string") }
        return value
    }

    func nonEmptyString(_ key: String, maxLength: Int = 200) throws(CallError) -> String {
        let value = try string(key).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw .badRequest("\(key) must not be empty") }
        guard value.count <= maxLength else { throw .badRequest("\(key) is longer than \(maxLength) characters") }
        return value
    }

    func int(_ key: String, in range: ClosedRange<Int>) throws(CallError) -> Int {
        guard let value = try optionalInt(key, in: range) else { throw .badRequest("\(call) needs \(key)") }
        return value
    }

    func optionalInt(_ key: String, in range: ClosedRange<Int>) throws(CallError) -> Int? {
        guard has(key) else { return nil }
        guard let number = values[key]?.numberValue, number.rounded() == number, let value = Int(exactly: number) else {
            throw .badRequest("\(key) must be a whole number")
        }
        guard range.contains(value) else {
            throw .badRequest("\(key) must be between \(range.lowerBound) and \(range.upperBound)")
        }
        return value
    }

    func date(_ key: String) throws(CallError) -> Date {
        guard let value = try optionalDate(key) else { throw .badRequest("\(call) needs \(key)") }
        return value
    }

    func optionalDate(_ key: String) throws(CallError) -> Date? {
        guard let text = try optionalString(key) else { return nil }
        guard let date = ISODate.parse(text) else {
            throw .badRequest("\(key) must be an ISO 8601 date-time with a time zone, such as 2026-05-01T07:00:00Z")
        }
        return date
    }

    func time(_ key: String) throws(CallError) -> TimeOfDay {
        guard let value = try optionalTime(key) else { throw .badRequest("\(call) needs \(key)") }
        return value
    }

    func optionalTime(_ key: String) throws(CallError) -> TimeOfDay? {
        guard let text = try optionalString(key) else { return nil }
        guard let time = TimeOfDay(text) else { throw .badRequest("\(key) must be a time of day as HH:MM, such as 07:30") }
        return time
    }

    /// At least one day, each once, returned in week order.
    func optionalDays(_ key: String) throws(CallError) -> [Weekday]? {
        guard has(key) else { return nil }
        guard let items = values[key]?.arrayValue else { throw .badRequest("\(key) must be an array of days") }
        var days: [Weekday] = []
        for item in items {
            guard let text = item.stringValue, let day = Weekday(rawValue: text) else {
                throw .badRequest("\(key) must only hold mon, tue, wed, thu, fri, sat or sun")
            }
            guard !days.contains(day) else { throw .badRequest("\(key) lists \(text) more than once") }
            days.append(day)
        }
        guard !days.isEmpty else { throw .badRequest("\(key) must list at least one day") }
        return days.sorted()
    }

    /// Lowercase letters, digits and `-`, as the host's slugs.
    func slug(_ key: String) throws(CallError) -> String {
        let value = try string(key)
        guard Slug.isValid(value) else {
            throw .badRequest("\(key) must be 1 to 64 lowercase letters, digits or -, such as social")
        }
        return value
    }
}

enum Slug {
    static func isValid(_ text: String) -> Bool {
        (1 ... 64).contains(text.count) && text.first != "-" && text.last != "-"
            && text.unicodeScalars.allSatisfy { ("a" ... "z").contains($0) || ("0" ... "9").contains($0) || $0 == "-" }
    }
}
