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
                        Button(Self.openSettingsTitle) {
                            if let url = Self.notificationSettingsURL { openURL(url) }
                        }
                    }
                }

                #if os(iOS)
                    AlarmsSection(model: model)
                    ScreenTimeSection(model: model)
                #endif
                FocusSection(model: model)
                #if os(iOS)
                    NFCSection(model: model)
                    HealthSection(model: model)
                #endif

                if model.pairing != nil {
                    Section {
                        Button("Sign Out", role: .destructive) { confirmingSignOut = true }
                    } footer: {
                        Text("Removes this device from the host. To use it again, connect it again.")
                    }
                }

                Section {
                    LabeledContent("Version", value: AppModel.appVersion)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            #endif
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
            #if os(iOS)
                .alert(model.nfcNotice ?? "", isPresented: nfcNoticeShown) {
                    Button("OK") {}
                }
            #endif
        }
        #if os(macOS)
            .frame(minWidth: 420, idealWidth: 480, minHeight: 360, idealHeight: 520)
        #endif
    }

    #if os(iOS)
        private var nfcNoticeShown: Binding<Bool> {
            Binding(get: { model.nfcNotice != nil }, set: { if !$0 { model.nfcNotice = nil } })
        }

        private static let openSettingsTitle = "Open Settings"
        private static let notificationSettingsURL = URL(string: UIApplication.openNotificationSettingsURLString)
    #else
        private static let openSettingsTitle = "Open System Settings"
        private static let notificationSettingsURL = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=dev.bgenc.hobwork")
    #endif

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
        guard let notifications else { return "" }
        if notifications.allowsNotifications { return "On" }
        switch notifications {
        case .denied: return "Off"
        case .notDetermined: return "Not set up"
        default: return ""
        }
    }
}

#if os(iOS)
private struct AlarmsSection: View {
    let model: AppModel

    var body: some View {
        Section {
            if model.capabilities.alarms {
                NavigationLink {
                    AlarmsView(model: model)
                } label: {
                    LabeledContent("Alarms and timers", value: "Allowed")
                }
            } else {
                LabeledContent("Alarms and timers", value: "Not allowed")
                Button("Allow Alarms") { Task { await model.requestAlarms() } }
            }
        } footer: {
            Text("Hobs can set alarms and timers that ring on this \(DeviceModel.name). If you declined before, allow alarms for Hobwork in the Settings app.")
        }
    }
}

#endif

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
            #if os(macOS)
                Text("To let hobs know when a Focus turns on or off, open System Settings, go to Focus, choose a Focus, click Add Filter, choose Hobwork and enter a label such as work.")
            #else
                Text("To let hobs know when a Focus turns on or off, open Settings, go to Focus, choose a Focus, tap Add Filter, choose Hobwork and enter a label such as work.")
            #endif
        }
        .task { labels = FocusLabels.file.read() }
    }
}

#if os(iOS)

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
            Text("Scanning a tag written by a hob runs that hob's handler for it. Tags with other links go to the hobs that handle those links. To use a tag without opening Hobwork, create a personal automation for it in the Shortcuts app and add Send Tag to Hobwork with the tag's link.")
        }
    }
}
#endif
