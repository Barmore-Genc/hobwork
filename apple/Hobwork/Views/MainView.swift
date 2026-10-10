import SwiftUI
import WebKit

struct MainView: View {
    let model: AppModel

    var body: some View {
        #if os(macOS)
            content
                .toolbar {
                    ToolbarItemGroup(placement: .navigation) {
                        Button("Back", systemImage: "chevron.backward") { model.web.goBack() }
                            .disabled(!model.web.canGoBack)
                        Button("Home", systemImage: "house") { model.web.goHome() }
                        Button("Reload", systemImage: "arrow.clockwise") { model.web.refresh() }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        SettingsLink {
                            Label("Settings", systemImage: "gearshape")
                                .overlay(alignment: .topTrailing) {
                                    ConnectionDot(state: model.connection?.state)
                                        .offset(x: 4, y: -2)
                                }
                        }
                        .help(ConnectionDot.text(for: model.connection?.state))
                    }
                }
                .navigationTitle(model.web.title ?? "Hobwork")
        #else
            NavigationStack {
                content
                    .toolbar(.hidden, for: .navigationBar)
                    .toolbar {
                        ToolbarItemGroup(placement: .bottomBar) {
                            Button("Back", systemImage: "chevron.backward") { model.web.goBack() }
                                .disabled(!model.web.canGoBack)
                            Button("Home", systemImage: "house") { model.web.goHome() }
                            Spacer()
                            Button {
                                model.sheet = .settings
                            } label: {
                                Label("Settings", systemImage: "gearshape")
                                    .overlay(alignment: .topTrailing) {
                                        ConnectionDot(state: model.connection?.state)
                                            .offset(x: 4, y: -2)
                                    }
                            }
                        }
                    }
            }
            .sheet(item: sheet) { sheet in
                switch sheet {
                case .settings:
                    SettingsView(model: model)
                case .alarms:
                    NavigationStack {
                        AlarmsView(model: model)
                            .toolbar {
                                ToolbarItem(placement: .confirmationAction) {
                                    Button("Done") { model.sheet = nil }
                                }
                            }
                    }
                }
            }
            .alert(model.nfcNotice ?? "", isPresented: nfcNoticeShown) {
                Button("OK") {}
            }
        #endif
    }

    private var content: some View {
        ZStack {
            WebView(webView: model.web.webView)
            if let error = model.web.loadError {
                ContentUnavailableView {
                    Label("Can't load Hobwork", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { model.web.refresh() }
                        .buttonStyle(.borderedProminent)
                }
                .background(.background)
            }
        }
    }

    #if os(iOS)
        private var sheet: Binding<AppModel.Sheet?> {
            Binding(get: { model.sheet }, set: { model.sheet = $0 })
        }

        private var nfcNoticeShown: Binding<Bool> {
            Binding(get: { model.nfcNotice != nil && model.sheet == nil }, set: { if !$0 { model.nfcNotice = nil } })
        }
    #endif
}

private struct ConnectionDot: View {
    let state: DeviceConnection.State?

    var body: some View {
        Circle()
            .fill(state == .connected ? Color.green : Color.orange)
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
    }

    static func text(for state: DeviceConnection.State?) -> String {
        state == .connected ? "Connected to Hobwork" : "Not connected to Hobwork"
    }
}

#if os(macOS)
    struct WebView: NSViewRepresentable {
        let webView: WKWebView

        func makeNSView(context: Context) -> WKWebView { webView }

        func updateNSView(_ nsView: WKWebView, context: Context) {}
    }

    /// The View menu's items for the web view.
    struct WebCommands: Commands {
        let model: AppModel

        var body: some Commands {
            CommandGroup(before: .toolbar) {
                Button("Back") { model.web.goBack() }
                    .keyboardShortcut("[", modifiers: .command)
                    .disabled(model.pairing == nil || !model.web.canGoBack)
                Button("Home") { model.web.goHome() }
                    .keyboardShortcut("h", modifiers: [.command, .shift])
                    .disabled(model.pairing == nil)
                Button("Reload") { model.web.refresh() }
                    .keyboardShortcut("r", modifiers: .command)
                    .disabled(model.pairing == nil)
                Divider()
            }
        }
    }
#else
    struct WebView: UIViewRepresentable {
        let webView: WKWebView

        func makeUIView(context: Context) -> WKWebView { webView }

        func updateUIView(_ uiView: WKWebView, context: Context) {}
    }
#endif
