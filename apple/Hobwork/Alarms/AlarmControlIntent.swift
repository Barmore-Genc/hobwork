import AlarmKit
import AppIntents
import Foundation

/// The timer and alarm buttons in the Live Activity. Part of the app and the widget
/// extension: the widget needs the type for its buttons, and iOS runs it in the app, which
/// AlarmKit authorized.
struct AlarmControlIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Control Alarm"
    static let isDiscoverable = false

    @Parameter(title: "Alarm")
    var alarmID: String

    @Parameter(title: "Action")
    var action: AlarmControl

    init() {}

    init(_ action: AlarmControl, alarmID: UUID) {
        self.action = action
        self.alarmID = alarmID.uuidString
    }

    func perform() throws -> some IntentResult {
        guard let id = UUID(uuidString: alarmID) else { return .result() }
        let manager = AlarmManager.shared
        switch action {
        case .pause: try manager.pause(id: id)
        case .resume: try manager.resume(id: id)
        case .cancel: try manager.cancel(id: id)
        case .stop: try manager.stop(id: id)
        }
        return .result()
    }
}

enum AlarmControl: String, AppEnum {
    case pause, resume, cancel, stop

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Action"
    static let caseDisplayRepresentations: [AlarmControl: DisplayRepresentation] = [
        .pause: "Pause",
        .resume: "Resume",
        .cancel: "Cancel",
        .stop: "Stop",
    ]
}
