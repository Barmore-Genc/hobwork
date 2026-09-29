import AlarmKit
import SwiftUI

@MainActor
final class AlarmKitScheduler: AlarmScheduling {
    private var manager: AlarmManager { .shared }

    var isAuthorized: Bool {
        manager.authorizationState == .authorized
    }

    func requestAuthorization() async -> Bool {
        await Self.requestAuthorization()
    }

    func schedule(_ alarm: AlarmRecord) async throws {
        try await Self.schedule(alarm)
    }

    /// AlarmManager is not Sendable, so its async methods are called off the main actor.
    private nonisolated static func requestAuthorization() async -> Bool {
        (try? await AlarmManager.shared.requestAuthorization()) == .authorized
    }

    private nonisolated static func schedule(_ alarm: AlarmRecord) async throws {
        guard let id = alarm.uuid else { return }
        let metadata = HobworkAlarmMetadata(title: alarm.title)
        let configuration: AlarmManager.AlarmConfiguration<HobworkAlarmMetadata>
        if let seconds = alarm.seconds {
            let presentation = AlarmPresentation(
                alert: Self.alert(title: alarm.title),
                countdown: AlarmPresentation.Countdown(title: LocalizedStringResource(stringLiteral: alarm.title))
            )
            configuration = .timer(
                duration: TimeInterval(seconds),
                attributes: AlarmAttributes(presentation: presentation, metadata: metadata, tintColor: .accentColor)
            )
        } else {
            let presentation = AlarmPresentation(alert: Self.alert(title: alarm.title))
            configuration = .alarm(
                schedule: Self.schedule(for: alarm),
                attributes: AlarmAttributes(presentation: presentation, metadata: metadata, tintColor: .accentColor)
            )
        }
        do {
            _ = try await AlarmManager.shared.schedule(id: id, configuration: configuration)
        } catch AlarmManager.AlarmError.maximumLimitReached {
            throw AlarmSchedulingError.limitReached
        }
    }

    func cancel(_ id: UUID) {
        try? manager.cancel(id: id)
    }

    func alarms() throws -> [(id: UUID, state: AlarmState)] {
        try manager.alarms.map { ($0.id, Self.state($0.state)) }
    }

    nonisolated static func schedule(for alarm: AlarmRecord) -> Alarm.Schedule? {
        if let at = alarm.at { return .fixed(at) }
        guard let time = alarm.time else { return nil }
        let repeats: Alarm.Schedule.Relative.Recurrence = alarm.days.map { .weekly($0.map(\.localeWeekday)) } ?? .never
        return .relative(Alarm.Schedule.Relative(time: .init(hour: time.hour, minute: time.minute), repeats: repeats))
    }

    nonisolated static func state(_ state: Alarm.State) -> AlarmState {
        switch state {
        case .scheduled: .scheduled
        case .countdown: .countdown
        case .paused: .paused
        case .alerting: .alerting
        @unknown default: .scheduled
        }
    }

    private nonisolated static func alert(title: String) -> AlarmPresentation.Alert {
        let title = LocalizedStringResource(stringLiteral: title)
        if #available(iOS 26.1, *) {
            return AlarmPresentation.Alert(title: title)
        }
        let stop = AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle")
        return AlarmPresentation.Alert(title: title, stopButton: stop)
    }
}
