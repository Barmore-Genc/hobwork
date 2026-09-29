import SwiftUI
import UserNotifications

struct SettingsView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var notifications: UNAuthorizationStatus?
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                if let pairing = model.pairing {
                    Section("Host") {
                        LabeledContent("Address", value: pairing.host.absoluteString)
                        LabeledContent("Device name", value: pairing.credentials.name)
                        LabeledContent("Connection", value: connectionText)
                        if model.connection?.state != .connected {
                            Button("Reconnect") { model.connection?.reconnect() }
                        }
                    }
                }

                Section {
                    LabeledContent("Notifications", value: notificationsText)
                    if notifications == .denied {
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        }
                    }
                }

                AlarmsSection(model: model)
                ScreenTimeSection(model: model)
                FocusSection(model: model)
                NFCSection(model: model)
                HealthSection(model: model)

                Section {
                    Button("Sign Out", role: .destructive) { confirmingSignOut = true }
                } footer: {
                    Text("Removes this device from the host. To use it again, connect it again.")
                }

                Section {
                    LabeledContent("Version", value: AppModel.appVersion)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Sign out of this host?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) {
                    Task {
                        dismiss()
                        await model.signOut()
                    }
                }
            }
            .task {
                notifications = await model.notifier.authorizationStatus()
                await model.refreshCapabilities()
            }
            .alert(model.nfcNotice ?? "", isPresented: nfcNoticeShown) {
                Button("OK") {}
            }
        }
    }

    private var nfcNoticeShown: Binding<Bool> {
        Binding(get: { model.nfcNotice != nil }, set: { if !$0 { model.nfcNotice = nil } })
    }

    private var connectionText: String {
        switch model.connection?.state {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .waiting: "Waiting to reconnect"
        case .ownerNotAllowed: "Your account can't sign in to this host"
        case .unauthorized: "Removed by the host"
        case .stopped, nil: "Not connected"
        }
    }

    private var notificationsText: String {
        switch notifications {
        case .authorized, .provisional, .ephemeral: "On"
        case .denied: "Off"
        case .notDetermined: "Not set up"
        default: ""
        }
    }
}

private struct AlarmsSection: View {
    let model: AppModel

    var body: some View {
        Section {
            LabeledContent("Alarms and timers", value: model.capabilities.alarms ? "Allowed" : "Not allowed")
            if !model.capabilities.alarms {
                Button("Allow Alarms") { Task { await model.requestAlarms() } }
            }
        } footer: {
            Text("Projects can set alarms and timers that ring on this iPhone. If you declined before, allow alarms for Hobwork in the Settings app.")
        }
    }
}

private struct FocusSection: View {
    let model: AppModel

    @State private var labels = FocusLabels()

    var body: some View {
        Section {
            LabeledContent("Focus", value: labels.setUp ? "Set up" : "Not set up")
            if !labels.active.isEmpty {
                LabeledContent("Active", value: labels.active.joined(separator: ", "))
            }
        } footer: {
            Text("To let projects know when a Focus turns on or off, open Settings, go to Focus, choose a Focus, tap Add Filter, choose Hobwork and enter a label such as work.")
        }
        .task { labels = FocusLabels.file.read() }
    }
}

private struct NFCSection: View {
    let model: AppModel

    var body: some View {
        Section {
            if model.capabilities.nfc {
                Button("Scan Tag") { Task { await model.scanTag() } }
            } else {
                LabeledContent("NFC", value: "Not available")
            }
        } footer: {
            Text("Scanning a tag written by a project runs that project's handler for it. Tags with other links go to the projects that handle those links. To use a tag without opening Hobwork, create a personal automation for it in the Shortcuts app and add Send Tag to Hobwork with the tag's link.")
        }
    }
}
