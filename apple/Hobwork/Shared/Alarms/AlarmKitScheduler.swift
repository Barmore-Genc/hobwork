import ActivityKit
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
        let metadata = HobworkAlarmMetadata(title: alarm.title, subtitle: alarm.subtitle, repeatTitle: alarm.repeatLabel)
        let attributes = AlarmAttributes(
            presentation: presentation(for: alarm),
            metadata: metadata,
            tintColor: Color(hex: alarm.tint) ?? .accentColor
        )
        // The intents tell the hob; AlarmKit stops the alarm or starts the next countdown itself.
        let stop = AlarmEventIntent(.stopped, alarmID: id)
        let configuration: AlarmManager.AlarmConfiguration<HobworkAlarmMetadata> = if let seconds = alarm.seconds {
            AlarmManager.AlarmConfiguration(
                countdownDuration: Alarm.CountdownDuration(preAlert: TimeInterval(seconds), postAlert: alarm.repeatSeconds.map(TimeInterval.init)),
                attributes: attributes,
                stopIntent: stop,
                secondaryIntent: alarm.repeatSeconds == nil ? nil : AlarmEventIntent(.repeated, alarmID: id)
            )
        } else {
            .alarm(schedule: Self.schedule(for: alarm), attributes: attributes, stopIntent: stop)
        }
        do {
            _ = try await AlarmManager.shared.schedule(id: id, configuration: configuration)
        } catch AlarmManager.AlarmError.maximumLimitReached {
            throw AlarmSchedulingError.limitReached
        }
    }

    nonisolated static func presentation(for alarm: AlarmRecord) -> AlarmPresentation {
        let title = LocalizedStringResource(stringLiteral: alarm.title)
        let alert = Self.alert(title: alarm.title, repeatTitle: alarm.repeatLabel)
        guard alarm.seconds != nil else { return AlarmPresentation(alert: alert) }
        let pause = AlarmButton(text: "Pause", textColor: .white, systemImageName: "pause.fill")
        let resume = AlarmButton(text: "Resume", textColor: .white, systemImageName: "play.fill")
        return AlarmPresentation(
            alert: alert,
            countdown: AlarmPresentation.Countdown(title: title, pauseButton: pause),
            paused: AlarmPresentation.Paused(title: title, resumeButton: resume)
        )
    }

    func cancel(_ id: UUID) {
        try? manager.cancel(id: id)
    }

    func alarms() throws -> [ScheduledAlarm] {
        let ends = Self.countdownEnds()
        return try manager.alarms.map { ScheduledAlarm(id: $0.id, state: Self.state($0.state), endsAt: ends[$0.id]) }
    }

    /// When running timers ring, from their Live Activities: AlarmKit tells the app nowhere else.
    static func countdownEnds() -> [UUID: Date] {
        var ends: [UUID: Date] = [:]
        for activity in Activity<AlarmAttributes<HobworkAlarmMetadata>>.activities {
            if case let .countdown(countdown) = activity.content.state.mode {
                ends[activity.content.state.alarmID] = countdown.fireDate
            }
        }
        return ends
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

    /// iOS 26.1 and later always show their own Stop button. The repeat button starts a new
    /// countdown of the alarm's post-alert duration under the same ID.
    nonisolated static func alert(title: String, repeatTitle: String? = nil) -> AlarmPresentation.Alert {
        let title = LocalizedStringResource(stringLiteral: title)
        let again = repeatTitle.map { AlarmButton(text: LocalizedStringResource(stringLiteral: $0), textColor: .white, systemImageName: "repeat") }
        let behavior: AlarmPresentation.Alert.SecondaryButtonBehavior? = again == nil ? nil : .countdown
        if #available(iOS 26.1, *) {
            return AlarmPresentation.Alert(title: title, secondaryButton: again, secondaryButtonBehavior: behavior)
        }
        let stop = AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle")
        return AlarmPresentation.Alert(title: title, stopButton: stop, secondaryButton: again, secondaryButtonBehavior: behavior)
    }
}
