import SwiftUI

struct AlarmsView: View {
    let model: AppModel

    @Environment(\.openURL) private var openURL
    @State private var list = AlarmList()

    var body: some View {
        List {
            ForEach(list.items) { item in
                AlarmRow(item: item) { list.perform($0, on: item) }
            }
        }
        .overlay {
            if !model.capabilities.alarms {
                ContentUnavailableView {
                    Label("Alarms Not Allowed", systemImage: "alarm")
                } description: {
                    Text("Allow Hobwork to set alarms and timers so your hobs can use them on this \(DeviceModel.name).")
                } actions: {
                    Button("Allow Alarms") { Task { await model.requestAlarms() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if list.items.isEmpty {
                ContentUnavailableView(
                    "No Alarms or Timers",
                    systemImage: "alarm",
                    description: Text("Alarms and timers your hobs set on this \(DeviceModel.name) show up here.")
                )
            }
        }
        .navigationTitle("Alarms and Timers")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.capabilities.alarms) {
            guard model.capabilities.alarms else { return }
            await list.watch()
        }
        .alert(model.alarmProblem?.title ?? "", isPresented: problemShown, presenting: model.alarmProblem) { problem in
            if problem.opensSettings {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            }
            Button("OK", role: .cancel) {}
        } message: { problem in
            Text(problem.message)
        }
        .alert("Couldn't Change the Alarm", isPresented: listProblemShown) {
            Button("OK") {}
        } message: {
            Text(list.problem ?? "")
        }
    }

    private var problemShown: Binding<Bool> {
        Binding(get: { model.alarmProblem != nil }, set: { if !$0 { model.alarmProblem = nil } })
    }

    private var listProblemShown: Binding<Bool> {
        Binding(get: { list.problem != nil && model.alarmProblem == nil }, set: { if !$0 { list.problem = nil } })
    }
}

private struct AlarmRow: View {
    let item: AlarmItem
    let perform: (AlarmItem.Action) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.kind == .timer ? "timer" : "alarm")
                .font(.title2)
                .foregroundStyle(item.status == .ringing ? Color.red : Color.accentColor)
                .frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.headline)
                HStack(spacing: 4) {
                    Text(item.kindText)
                    Text("·")
                    Text(item.stateText)
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                detail
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            ForEach(item.actions.filter { $0 != .cancel }, id: \.self) { action in
                Button {
                    perform(action)
                } label: {
                    Label(Self.title(action), systemImage: Self.image(action))
                        .labelStyle(.iconOnly)
                        .font(.title3)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)
                .tint(action == .stop ? .red : .accentColor)
            }
            if item.actions.contains(.cancel) {
                Button(role: .destructive) {
                    perform(.cancel)
                } label: {
                    Label(Self.title(.cancel), systemImage: Self.image(.cancel))
                        .labelStyle(.iconOnly)
                        .font(.title3)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            ForEach(item.actions, id: \.self) { action in
                Button(Self.title(action)) { perform(action) }
            }
        }
    }

    @ViewBuilder private var detail: some View {
        if case let .running(endsAt?) = item.status {
            Text(timerInterval: Date.now ... max(endsAt, .now), countsDown: true)
        } else if let text = item.detailText() {
            Text(text)
        }
    }

    static func title(_ action: AlarmItem.Action) -> String {
        switch action {
        case .pause: "Pause"
        case .resume: "Resume"
        case .stop: "Stop"
        case .cancel: "Cancel"
        }
    }

    static func image(_ action: AlarmItem.Action) -> String {
        switch action {
        case .pause: "pause.fill"
        case .resume: "play.fill"
        case .stop: "stop.fill"
        case .cancel: "xmark"
        }
    }
}
