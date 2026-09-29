import AuthenticationServices
import SwiftUI

struct OnboardingView: View {
    let model: AppModel

    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @AppStorage("lastHostInput") private var hostInput = ""
    @State private var deviceName = Self.defaultDeviceName
    @State private var error: String?
    @State private var pairing = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "house.fill")
                            .font(.largeTitle)
                            .foregroundStyle(.tint)
                        Text("Connect to your Hobwork host to see your projects and get their notifications on this device.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

                if let notice = model.notice {
                    Section {
                        Label(notice, systemImage: "exclamationmark.triangle")
                    }
                }

                Section {
                    TextField("hobwork.example.com", text: $hostInput, prompt: Text("hobwork.example.com"))
                        .addressInput()
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit(pair)
                } header: {
                    Text("Host address")
                }

                Section {
                    TextField("Device name", text: $deviceName, prompt: Text("Device name"))
                        .plainTextInput()
                } header: {
                    Text("Device name")
                } footer: {
                    Text("Projects reach this device by name. You can adjust it when you approve the connection.")
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }

                Section {
                    Button(action: pair) {
                        HStack {
                            Text("Connect")
                            if pairing {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(pairing || hostInput.trimmingCharacters(in: .whitespaces).isEmpty
                        || deviceName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Hobwork")
        }
    }

    private static var defaultDeviceName: String {
        #if os(macOS)
            Host.current().localizedName ?? "Mac"
        #else
            UIDevice.current.name
        #endif
    }

    private func pair() {
        guard !pairing else { return }
        focused = false
        error = nil
        let host: URL
        do {
            host = try HostURL.normalize(hostInput)
        } catch {
            self.error = error.localizedDescription
            return
        }
        let name = deviceName.trimmingCharacters(in: .whitespaces)
        pairing = true
        Task {
            defer { pairing = false }
            do {
                _ = try await HostAPI(host: host).probe()
                let request = Pairing(host: host, deviceName: name)
                let callback = try await webAuthenticationSession.authenticate(
                    using: request.url,
                    callback: .customScheme(Pairing.callbackScheme),
                    preferredBrowserSession: .shared,
                    additionalHeaderFields: [:]
                )
                let code = try request.code(from: callback)
                let credentials = try await HostAPI(host: host).exchange(code: code, verifier: request.pkce.verifier)
                try model.completePairing(host: host, credentials: credentials)
            } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                return
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

extension View {
    /// A field for a web address. macOS forms show a field's title as a label next to it;
    /// the section header already names these fields, so they show only their prompt.
    func addressInput() -> some View {
        #if os(iOS)
            keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        #else
            textContentType(.URL)
                .autocorrectionDisabled()
                .labelsHidden()
        #endif
    }

    func plainTextInput() -> some View {
        #if os(iOS)
            textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        #else
            autocorrectionDisabled()
                .labelsHidden()
        #endif
    }
}
