import HealthKit
import SwiftUI

struct HealthSection: View {
    let model: AppModel

    @State private var shared: Set<HealthType> = []
    @State private var error: String?

    var body: some View {
        Section {
            if HKHealthStore.isHealthDataAvailable() {
                ForEach(HealthType.allCases, id: \.self) { type in
                    Toggle(type.title, isOn: binding(for: type))
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
            Text("Hobs can read the types you share and get new samples as they arrive. Health asks which data Hobwork may read. Health data can't be read while this \(DeviceModel.name) is locked.")
        }
        .task { shared = HealthSharing.file.read().types }
    }

    private func binding(for type: HealthType) -> Binding<Bool> {
        Binding(
            get: { shared.contains(type) },
            set: { on in
                var next = shared
                if on { next.insert(type) } else { next.remove(type) }
                shared = next
                Task {
                    do {
                        error = nil
                        try await model.shareHealth(next)
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            }
        )
    }
}
