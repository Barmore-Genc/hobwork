import FamilyControls
import SwiftUI

struct ScreenTimeSection: View {
    let model: AppModel

    @State private var sets: [AppSet] = []
    @State private var error: String?

    var body: some View {
        Section {
            if !AppGroup.hasFamilyControls {
                LabeledContent("Screen Time", value: "Not available in this version")
            } else {
                LabeledContent("Screen Time", value: model.capabilities.screenTime ? "Allowed" : "Not allowed")
                if !model.capabilities.screenTime {
                    Button("Allow Screen Time") {
                        Task {
                            do {
                                try await model.requestScreenTime()
                            } catch {
                                self.error = error.localizedDescription
                            }
                        }
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                ForEach(sets) { set in
                    NavigationLink {
                        AppSetEditor(existing: set) { reload() }
                    } label: {
                        LabeledContent(set.name, value: Self.summary(set))
                    }
                }
                .onDelete { offsets in
                    let names = offsets.map { sets[$0].name }
                    ScreenTimeState.file.update { $0.sets.removeAll { names.contains($0.name) } }
                    reload()
                }
                NavigationLink("Add App Set") {
                    AppSetEditor(existing: nil) { reload() }
                }
            }
        } header: {
            Text("Screen Time")
        } footer: {
            Text("Projects block, schedule and limit app sets by name, such as social. They never see which apps a set holds.")
        }
        .task { reload() }
    }

    private func reload() {
        sets = ScreenTimeState.file.read().sets.sorted { $0.name < $1.name }
    }

    static func summary(_ set: AppSet) -> String {
        [
            set.apps > 0 ? "\(set.apps) apps" : nil,
            set.categories > 0 ? "\(set.categories) categories" : nil,
            set.sites > 0 ? "\(set.sites) websites" : nil,
        ].compactMap(\.self).joined(separator: ", ")
    }
}

private struct AppSetEditor: View {
    let existing: AppSet?
    let onSave: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var selection = FamilyActivitySelection()
    @State private var picking = false

    var body: some View {
        Form {
            Section {
                TextField("social", text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(existing != nil)
            } header: {
                Text("Name")
            } footer: {
                Text("Lowercase letters, digits and dashes. Projects use this name.")
            }
            Section {
                Button("Choose Apps and Websites") { picking = true }
                LabeledContent("Apps", value: "\(selection.applicationTokens.count)")
                LabeledContent("Categories", value: "\(selection.categoryTokens.count)")
                LabeledContent("Websites", value: "\(selection.webDomainTokens.count)")
            }
        }
        .navigationTitle(existing == nil ? "New App Set" : existing!.name)
        .familyActivityPicker(isPresented: $picking, selection: $selection)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save).disabled(!Slug.isValid(name))
            }
        }
        .onAppear {
            guard let existing else { return }
            name = existing.name
            selection = (try? JSONDecoder().decode(FamilyActivitySelection.self, from: existing.selection)) ?? FamilyActivitySelection()
        }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(selection) else { return }
        let set = AppSet(
            name: name,
            selection: data,
            apps: selection.applicationTokens.count,
            categories: selection.categoryTokens.count,
            sites: selection.webDomainTokens.count
        )
        ScreenTimeState.file.update { state in
            state.sets.removeAll { $0.name == set.name }
            state.sets.append(set)
        }
        onSave()
        dismiss()
    }
}
