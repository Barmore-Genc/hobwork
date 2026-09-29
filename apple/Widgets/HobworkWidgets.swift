import ActivityKit
import AlarmKit
import SwiftUI
import WidgetKit

@main
struct HobworkWidgets: WidgetBundle {
    var body: some Widget {
        AlarmLiveActivity()
    }
}

/// The Live Activity AlarmKit shows for a timer's countdown and for alarms that are paused
/// or ringing.
struct AlarmLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlarmAttributes<HobworkAlarmMetadata>.self) { context in
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.metadata?.title ?? "Hobwork")
                        .font(.headline)
                    AlarmStatusText(state: context.state)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                AlarmCountdown(state: context.state)
                    .font(.title.monospacedDigit())
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
            } compactLeading: {
                Image(systemName: "timer")
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
