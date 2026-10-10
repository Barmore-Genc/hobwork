import Foundation
import Testing
import WebKit
@testable import Hobwork

/// The page script and the WebKit side of the bridge, in a real web view. Pages loaded
/// from a string take the origin of their base URL.
@MainActor
struct BridgeWebViewTests {
    let presenter = FakePresenter()
    let webView: WKWebView
    let bridge: NativeBridge

    init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let gatekeeper = BridgeGatekeeper(store: MemoryPermissionStore(), prompter: FakePrompter(answer: true))
        bridge = NativeBridge(controller: configuration.userContentController, gatekeeper: gatekeeper)
        bridge.router.register(EchoCapability())
        bridge.configure(policy: LinkPolicy(host: URL(string: "https://hobwork.example.com")!))
        webView = WKWebView(frame: .zero, configuration: configuration)
        bridge.attach(to: webView, presenter: presenter)
    }

    func load(_ origin: String) async throws {
        webView.loadHTMLString("<!doctype html><title>t</title>", baseURL: URL(string: origin)!)
        for _ in 0 ..< 100 {
            if webView.url?.absoluteString.hasPrefix(origin) == true, !webView.isLoading,
               try await webView.evaluateJavaScript("document.readyState") as? String == "complete"
            {
                return
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        Issue.record("The page did not load")
    }

    func run(_ script: String) async throws -> Any? {
        try await webView.callAsyncJavaScript(script, contentWorld: .page)
    }

    @Test func hobPagesCallThroughTheBridge() async throws {
        try await load("https://filament.apps.hobwork.example.com/")
        let shape = try await run("const b = window.hobworkNative; return [b.version, b.platform, b.capabilities.echo.includes('say')]") as? [Any]
        #expect(shape?[0] as? Int == 1)
        #expect(shape?[1] as? String == Hello.platform)
        #expect(shape?[2] as? Bool == true)

        let reply = try await run("return await window.hobworkNative.call('echo', 'say', 'hi')") as? [String: Any]
        #expect(reply?["ok"] as? Bool == true)
        #expect((reply?["value"] as? [String: Any])?["hob"] as? String == "filament")

        let missing = try await run("return await window.hobworkNative.call('nfc', 'read')") as? [String: Any]
        #expect((missing?["error"] as? [String: Any])?["code"] as? String == "unavailable")
    }

    @Test func hobPagesReceiveEvents() async throws {
        try await load("https://filament.apps.hobwork.example.com/")
        let event = try await run("""
        const bridge = window.hobworkNative
        const got = new Promise((resolve) => bridge.listen('echo.pong', resolve))
        await new Promise((resolve) => setTimeout(resolve, 50))
        await bridge.call('echo', 'ping', { n: 1 })
        return await got
        """) as? [String: Any]
        #expect(event?["n"] as? Int == 1)
    }

    @Test(arguments: ["https://hobwork.example.com/", "https://example.com/"])
    func otherPagesGetNothing(origin: String) async throws {
        try await load(origin)
        #expect(try await run("return typeof window.hobworkNative") as? String == "undefined")
        let reply = try await run("""
        return await window.webkit.messageHandlers.hobworkNative.postMessage({ capability: 'echo', method: 'say', args: 'hi', page: 'x' })
        """) as? [String: Any]
        #expect(reply?["ok"] as? Bool == false)
        #expect((reply?["error"] as? [String: Any])?["code"] as? String == "unavailable")
    }
}
