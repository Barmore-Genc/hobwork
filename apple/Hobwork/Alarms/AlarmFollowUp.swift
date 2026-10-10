import Foundation

/// What the app shows after running a tapped alarms command: the alarms screen, with the
/// problem on top when the command failed.
struct AlarmFollowUp: Equatable {
    struct Problem: Equatable {
        var title: String
        var message: String
        /// Alarms are turned off for Hobwork, which only the Settings app can change.
        var opensSettings: Bool
    }

    var problem: Problem?

    /// Nil for commands of other capabilities.
    static func after(_ command: DeviceCommand, outcome: CommandOutcome?, deviceName: String) -> AlarmFollowUp? {
        guard command.capability == AlarmsCapability.capability else { return nil }
        guard let outcome, !outcome.ok else { return AlarmFollowUp() }
        let error = outcome.error ?? CallError(code: "failed", message: "Something went wrong.")
        let title = switch command.method {
        case "set": "Couldn't Set the Alarm"
        case "timer": "Couldn't Start the Timer"
        case "cancel": "Couldn't Cancel the Alarm"
        default: "Couldn't Check Alarms"
        }
        if error.code == "not_authorized" {
            return AlarmFollowUp(problem: Problem(
                title: title,
                message: "Hobwork isn't allowed to set alarms and timers on this \(deviceName). Allow it in Settings.",
                opensSettings: true
            ))
        }
        return AlarmFollowUp(problem: Problem(title: title, message: error.message, opensSettings: false))
    }
}
