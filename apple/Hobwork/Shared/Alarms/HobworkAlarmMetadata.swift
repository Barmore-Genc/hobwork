import AlarmKit
import SwiftUI

/// Shared with the widget extension, whose Live Activity shows a timer's countdown.
struct HobworkAlarmMetadata: AlarmMetadata {
    var title: String
    var subtitle: String?
    /// The repeat button's text, such as "+2 h".
    var repeatTitle: String?
}

/// What happened to a ringing alarm, as hobs get it.
enum AlarmEventKind: String, Sendable {
    case fired, stopped, repeated
}

/// Lets the alarm intents, which the widget extension also builds, report to the app.
@MainActor
enum AlarmEventHook {
    static var report: ((AlarmEventKind, UUID) async -> Void)?
}

extension Color {
    /// `#RRGGBB`, or nil.
    init?(hex: String?) {
        guard let hex, hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
