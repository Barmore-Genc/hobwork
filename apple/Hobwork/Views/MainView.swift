import SwiftUI
import WebKit

struct MainView: View {
    let model: AppModel

    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
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
            .toolbar(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Back", systemImage: "chevron.backward") { model.web.goBack() }
                        .disabled(!model.web.canGoBack)
                    Button("Home", systemImage: "house") { model.web.goHome() }
                    Spacer()
                    Button {
                        showingSettings = true
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
        .sheet(isPresented: $showingSettings) {
            SettingsView(model: model)
        }
    }
}

private struct ConnectionDot: View {
    let state: DeviceConnection.State?

    var body: some View {
        Circle()
            .fill(state == .connected ? Color.green : Color.orange)
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
    }
}

struct WebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
