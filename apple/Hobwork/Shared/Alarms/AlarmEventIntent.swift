import AppIntents
import Foundation

/// Runs when someone taps Stop or the repeat button of a ringing Hobwork alarm. AlarmKit
/// already stopped it or started the next countdown; this tells the hob. iOS runs it in the
/// app, launched in the background if needed.
struct AlarmEventIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Report Alarm"
    static let isDiscoverable = false

    @Parameter(title: "Alarm")
    var alarmID: String

    @Parameter(title: "Event")
    var event: String

    init() {}

    init(_ event: AlarmEventKind, alarmID: UUID) {
        self.event = event.rawValue
        self.alarmID = alarmID.uuidString
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let id = UUID(uuidString: alarmID), let kind = AlarmEventKind(rawValue: event) else { return .result() }
        await AlarmEventHook.report?(kind, id)
        return .result()
    }
}
