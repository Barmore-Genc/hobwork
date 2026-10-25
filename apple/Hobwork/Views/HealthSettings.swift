import HealthKit
import SwiftUI

struct HealthSection: View {
    let model: AppModel

    @Environment(\.openURL) private var openURL

    @State private var connected = false
    @State private var needsRequest = false
    @State private var error: String?

    var body: some View {
        Section {
            if HKHealthStore.isHealthDataAvailable() {
                Toggle("Health", isOn: binding)
                if connected && needsRequest {
                    Button("Allow New Data Types") { Task { await setConnected(true) } }
                }
                if connected {
                    Button("Change Access") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            } else {
                LabeledContent("Health", value: "Not available")
            }
        } header: {
            Text("Health")
        } footer: {
            Text("Hobs can read the Health data you allow and get new samples as they arrive. To change what Hobwork may read, open the Health app, tap your picture, then Apps, then Hobwork. Health data can't be read while this \(DeviceModel.name) is locked.")
        }
        .task { await refresh() }
    }

    private var binding: Binding<Bool> {
        Binding(
            get: { connected },
            set: { on in
                guard on != connected else { return }
                connected = on
                Task { await setConnected(on) }
            }
        )
    }

    private func refresh() async {
        connected = HealthSharing.file.read().isConnected
        needsRequest = await model.health.needsRequest()
    }

    private func setConnected(_ on: Bool) async {
        error = nil
        do {
            if on {
                try await model.connectHealth()
            } else {
                await model.disconnectHealth()
            }
        } catch {
            self.error = error.localizedDescription
        }
        await refresh()
    }
}
