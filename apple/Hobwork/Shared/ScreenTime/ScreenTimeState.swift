import Foundation

/// A named set of apps, categories and websites the person picked. The selection is
/// opaque and only works on this device, so handlers only ever see the name and counts.
struct AppSet: Codable, Equatable, Identifiable, Sendable {
    var name: String
    /// A JSON-encoded `FamilyActivitySelection`.
    var selection: Data
    var apps: Int
    var categories: Int
    var sites: Int

    var id: String { name }
}

struct ScreenTimeBlock: Codable, Equatable, Sendable {
    var set: String
    var until: Date?
}

struct ScreenTimeSchedule: Codable, Equatable, Sendable {
    var name: String
    var set: String
    var start: TimeOfDay
    var end: TimeOfDay
    var days: [Weekday]?
}

struct ScreenTimeLimit: Codable, Equatable, Sendable {
    var name: String
    var set: String
    var minutes: Int
    var days: [Weekday]?
    /// The local day (`yyyy-MM-dd`) the limit was last reached.
    var reachedOn: String?
}

/// Screen Time state shared by the app, the notification service extension and the
/// monitor extension.
struct ScreenTimeState: Codable, Equatable, Sendable {
    var sets: [AppSet] = []
    var blocks: [ScreenTimeBlock] = []
    var schedules: [ScreenTimeSchedule] = []
    var limits: [ScreenTimeLimit] = []

    static let file = SharedFile(name: "screen-time.json", empty: ScreenTimeState())

    func set(named name: String) -> AppSet? {
        sets.first { $0.name == name }
    }

    static func day(of date: Date, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }
}
