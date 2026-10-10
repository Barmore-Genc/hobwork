import HealthKit
import SwiftUI

struct HealthSection: View {
    let model: AppModel

    @State private var connected = false
    @State private var needsRequest = false
    @State private var error: String?

    var body: some View {
        Section {
            if HKHealthStore.isHealthDataAvailable() {
                if connected {
                    LabeledContent("Health", value: "Connected")
                }
                if !connected || needsRequest {
                    Button("Connect Health") { Task { await connect() } }
                }
                if connected {
                    Button("Disconnect", role: .destructive) { Task { await disconnect() } }
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

    private func refresh() async {
        connected = !HealthSharing.file.read().types.isEmpty
        needsRequest = await model.health.needsRequest()
    }

    private func connect() async {
        do {
            error = nil
            try await model.connectHealth()
        } catch {
            self.error = error.localizedDescription
        }
        await refresh()
    }

    private func disconnect() async {
        error = nil
        await model.disconnectHealth()
        await refresh()
    }
}
