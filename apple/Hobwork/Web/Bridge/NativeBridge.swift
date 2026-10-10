import Foundation
import WebKit

/// Connects hob pages in the web view to the `BridgeRouter`. Only frames on a hob's app
/// origin get answers, and only when the top-level page is the Hobwork web UI (which frames
/// hob apps) or that same hob.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    let router: BridgeRouter
    private let controller: WKUserContentController
    private weak var presenter: (any BridgePresenter)?
    private var policy: LinkPolicy?

    init(controller: WKUserContentController, gatekeeper: BridgeGatekeeper) {
        self.controller = controller
        var frameScripts: ((WKFrameInfo, String) async -> Bool)?
        router = BridgeRouter(gatekeeper: gatekeeper) { frame, script in
            guard let frame = frame as? WKFrameInfo else { return false }
            return await frameScripts?(frame, script) ?? false
        }
        super.init()
        frameScripts = { [weak self] frame, script in
            guard let webView = frame.webView ?? self?.webView else { return false }
            return (try? await webView.evaluateJavaScript(script, in: frame, contentWorld: .page)) as? Bool ?? false
        }
        controller.addScriptMessageHandler(self, contentWorld: .page, name: BridgeScript.handlerName)
    }

    private weak var webView: WKWebView?

    func attach(to webView: WKWebView, presenter: any BridgePresenter) {
        self.webView = webView
        self.presenter = presenter
    }

    /// Injects the page script for this host's hob origins, after the capabilities are
    /// registered. Nil removes it, for signing out.
    func configure(policy: LinkPolicy?) {
        self.policy = policy
        router.reset()
        controller.removeAllUserScripts()
        guard let policy else { return }
        let source = BridgeScript.source(appsHosts: policy.appsHosts, platform: Hello.platform, manifest: router.manifest)
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        guard let origin = allowedOrigin(of: message.frameInfo, topLevel: message.webView?.url),
              let presenter, let body = JSONValue(foundationValue: message.body)
        else {
            let error = BridgeError.unavailable("Native features are only available to hobs in the Hobwork app")
            return (JSONValue.object(["ok": .bool(false), "error": .object(["code": .string(error.code.rawValue), "message": .string(error.message)])]).foundationValue, nil)
        }
        let reply = await router.handle(body: body, origin: origin, frame: message.frameInfo, presenter: presenter)
        return (reply.foundationValue, nil)
    }

    func allowedOrigin(of frame: WKFrameInfo, topLevel: URL?) -> HobOrigin? {
        let security = frame.securityOrigin
        let port = security.port == 0 ? nil : security.port
        return policy?.bridgeOrigin(
            scheme: security.protocol, host: security.host, port: port,
            isMainFrame: frame.isMainFrame, topLevel: topLevel
        )
    }
}

extension LinkPolicy {
    /// The hob a bridge message is from, or nil when the bridge must not answer it: frames
    /// that are not on a hob's origin, and hob frames inside pages other than the Hobwork
    /// web UI or the same hob.
    func bridgeOrigin(scheme: String, host target: String, port: Int?, isMainFrame: Bool, topLevel: URL?) -> HobOrigin? {
        guard let origin = hobOrigin(scheme: scheme, host: target, port: port) else { return nil }
        if isMainFrame { return origin }
        guard let topLevel, let topHost = topLevel.host()?.lowercased() else { return nil }
        if topHost == host.host?.lowercased(), topLevel.scheme?.lowercased() == host.scheme?.lowercased() { return origin }
        return hobOrigin(of: topLevel) == origin ? origin : nil
    }
}
