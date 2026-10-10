import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// A hob's Live Activity, on the Lock Screen and in the Dynamic Island.
struct HobLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: HobworkActivityAttributes.self) { context in
            HobActivityView(attributes: context.attributes, state: context.state)
                .padding()
                .widgetURL(HobLink(hob: context.attributes.hob, path: context.state.open)?.url)
        } dynamicIsland: { context in
            let state = context.state
            let tint = Color(hex: state.tint) ?? .accentColor
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        HobActivityBadge(state: state)
                        Text(state.title)
                            .font(.headline)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HobActivityFigure(state: state)
                        .font(.title2.monospacedDigit())
                        .frame(maxWidth: 110, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        HobActivitySubtitle(state: state)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        HobActivityProgress(state: state, tint: tint)
                        HobActivityButton(attributes: context.attributes, state: state, tint: tint)
                    }
                }
            } compactLeading: {
                HobActivityBadge(state: state)
            } compactTrailing: {
                HobActivityFigure(state: state, compact: true)
                    .monospacedDigit()
                    .frame(maxWidth: 64)
            } minimal: {
                Image(systemName: state.icon ?? "circle.fill")
                    .foregroundStyle(tint)
            }
            .keylineTint(tint)
            .widgetURL(HobLink(hob: context.attributes.hob, path: state.open)?.url)
        }
    }
}

struct HobActivityView: View {
    let attributes: HobworkActivityAttributes
    let state: HobworkActivityAttributes.ContentState

    var body: some View {
        let tint = Color(hex: state.tint) ?? .accentColor
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                HobActivityBadge(state: state)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title)
                        .font(.headline)
                        .lineLimit(2)
                    HobActivitySubtitle(state: state)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    HobActivityFigure(state: state)
                        .font(.title.monospacedDigit().weight(.semibold))
                    HobActivityFigureLabel(state: state)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            HobActivityProgress(state: state, tint: tint)
            HobActivityButton(attributes: attributes, state: state, tint: tint)
        }
    }
}

/// The icon, or the swatches as dots.
struct HobActivityBadge: View {
    let state: HobworkActivityAttributes.ContentState

    var body: some View {
        if let icon = state.icon {
            Image(systemName: icon)
                .foregroundStyle(Color(hex: state.tint) ?? .accentColor)
        } else if let swatches = state.swatches, !swatches.isEmpty {
            SwatchDots(colors: swatches, size: 10)
        }
    }
}

struct HobActivitySubtitle: View {
    let state: HobworkActivityAttributes.ContentState

    var body: some View {
        if state.stillRunning == true, let end = state.endDate {
            Text("Still running, ends \(end, style: .time)")
        } else if let subtitle = state.subtitle {
            Text(subtitle)
        }
    }
}

/// The big text: the hob's value, or a countdown to `endsAt`. Past the time iOS keeps an
/// activity updating, a countdown would be wrong, so it shows the end time instead.
struct HobActivityFigure: View {
    let state: HobworkActivityAttributes.ContentState
    var compact = false

    var body: some View {
        if let value = state.value {
            Text(value)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        } else if let end = state.endDate {
            if state.stillRunning == true {
                Text(end, style: .time)
            } else {
                Text(timerInterval: min(Date.now, end) ... end, countsDown: true)
                    .multilineTextAlignment(.trailing)
            }
        } else if compact, let icon = state.icon {
            Image(systemName: icon)
        }
    }
}

struct HobActivityFigureLabel: View {
    let state: HobworkActivityAttributes.ContentState

    var body: some View {
        if state.value != nil, let label = state.valueLabel {
            Text(label)
        } else if state.value == nil, let end = state.endDate {
            if state.stillRunning == true {
                Text("ends")
            } else {
                Text("ends \(end, style: .time)")
            }
        }
    }
}

struct HobActivityProgress: View {
    let state: HobworkActivityAttributes.ContentState
    let tint: Color

    var body: some View {
        if let progress = state.progress {
            ProgressView(value: min(max(progress, 0), 1))
                .tint(tint)
        } else if state.stillRunning != true, let start = state.startDate, let end = state.endDate, start < end {
            ProgressView(timerInterval: start ... end, countsDown: false) {
                EmptyView()
            } currentValueLabel: {
                EmptyView()
            }
            .tint(tint)
        }
    }
}

struct HobActivityButton: View {
    let attributes: HobworkActivityAttributes
    let state: HobworkActivityAttributes.ContentState
    let tint: Color

    var body: some View {
        if let button = state.button, !attributes.id.isEmpty {
            Group {
                if button.opensApp == true {
                    Button(intent: LiveActivityOpenButtonIntent(id: attributes.id, hob: attributes.hob, path: state.open)) {
                        Text(button.title).frame(maxWidth: .infinity)
                    }
                } else {
                    Button(intent: LiveActivityButtonIntent(id: attributes.id)) {
                        Text(button.title).frame(maxWidth: .infinity)
                    }
                }
            }
            .font(.headline)
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(tint)
        }
    }
}

struct SwatchDots: View {
    let colors: [String]
    var size: CGFloat = 10

    var body: some View {
        HStack(spacing: size * 0.3) {
            ForEach(Array(colors.prefix(8).enumerated()), id: \.offset) { _, hex in
                Circle()
                    .fill(Color(hex: hex) ?? .secondary)
                    .overlay(Circle().strokeBorder(.primary.opacity(0.2), lineWidth: 0.5))
                    .frame(width: size, height: size)
            }
        }
    }
}
