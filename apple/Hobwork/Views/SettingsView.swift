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
            .task { notifications = await model.notifier.authorizationStatus() }
        }
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
