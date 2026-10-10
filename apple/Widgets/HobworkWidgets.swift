import ActivityKit
import AlarmKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct HobworkWidgets: WidgetBundle {
    var body: some Widget {
        AlarmLiveActivity()
        HobLiveActivity()
        HobWidget()
        HobActionControl()
        HobPageControl()
    }
}

/// The Live Activity AlarmKit shows for a timer's countdown and for alarms that are paused
/// or ringing.
struct AlarmLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlarmAttributes<HobworkAlarmMetadata>.self) { context in
            VStack(spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.metadata?.title ?? "Hobwork")
                            .font(.headline)
                        if let subtitle = context.attributes.metadata?.subtitle {
                            Text(subtitle)
                                .font(.subheadline)
                                .lineLimit(1)
                        }
                        AlarmStatusText(state: context.state)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    AlarmCountdown(state: context.state)
                        .font(.title.monospacedDigit())
                }
                AlarmControls(state: context.state, tint: context.attributes.tintColor, repeatTitle: context.attributes.metadata?.repeatTitle)
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.attributes.metadata?.title ?? "Hobwork")
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    AlarmCountdown(state: context.state)
                        .font(.title2.monospacedDigit())
                }
                DynamicIslandExpandedRegion(.bottom) {
                    AlarmControls(state: context.state, tint: context.attributes.tintColor, repeatTitle: context.attributes.metadata?.repeatTitle)
                }
            } compactLeading: {
                Image(systemName: "timer")
                    .foregroundStyle(context.attributes.tintColor)
            } compactTrailing: {
                AlarmCountdown(state: context.state)
                    .monospacedDigit()
                    .frame(maxWidth: 56)
            } minimal: {
                Image(systemName: "timer")
            }
            .keylineTint(context.attributes.tintColor)
        }
    }
}

private struct AlarmCountdown: View {
    let state: AlarmPresentationState

    var body: some View {
        switch state.mode {
        case let .countdown(countdown):
            Text(timerInterval: Date.now ... countdown.fireDate, countsDown: true)
                .multilineTextAlignment(.trailing)
        case let .paused(paused):
            Text(Duration.seconds(paused.totalCountdownDuration - paused.previouslyElapsedDuration), format: .time(pattern: .minuteSecond))
        case .alert:
            Image(systemName: "alarm.waves.left.and.right")
        @unknown default:
            EmptyView()
        }
    }
}

private struct AlarmControls: View {
    let state: AlarmPresentationState
    let tint: Color
    let repeatTitle: String?

    var body: some View {
        HStack {
            switch state.mode {
            case .countdown:
                control(.pause, "Pause", systemImage: "pause.fill", tint: tint)
                control(.cancel, "Cancel", systemImage: "xmark", tint: .gray)
            case .paused:
                control(.resume, "Resume", systemImage: "play.fill", tint: tint)
                control(.cancel, "Cancel", systemImage: "xmark", tint: .gray)
            case .alert:
                control(.stop, "Stop", systemImage: "stop.fill", tint: .red)
                if let repeatTitle {
                    control(.repeat, LocalizedStringKey(repeatTitle), systemImage: "repeat", tint: tint)
                }
            @unknown default:
                EmptyView()
            }
        }
        .font(.headline)
    }

    private func control(_ action: AlarmControl, _ title: LocalizedStringKey, systemImage: String, tint: Color) -> some View {
        Button(intent: AlarmControlIntent(action, alarmID: state.alarmID)) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .tint(tint)
    }
}

private struct AlarmStatusText: View {
    let state: AlarmPresentationState

    var body: some View {
        switch state.mode {
        case .countdown: Text("Timer")
        case .paused: Text("Paused")
        case .alert: Text("Ringing")
        @unknown default: EmptyView()
        }
    }
}
