#if os(macOS)
    import AppKit
#else
    import UIKit
#endif
import WebKit

/// `alert()`, `confirm()` and `prompt()` from hob pages.
///
/// A web view that does not implement these answers every `confirm()` with "Cancel" at once and
/// ignores `alert()` and `prompt()`, so any button that asks "Are you sure?" with a browser pop-up
/// silently does nothing. These show a system alert over the page instead. The title is the page's
/// host, so it is clear which page is asking. With nothing to present on, they answer "Cancel" so
/// the page is never left waiting.
extension WebController {
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable () -> Void
    ) {
        #if os(macOS)
            let alert = NSAlert()
            alert.messageText = frame.request.url?.host ?? ""
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            if let window = webView.window {
                alert.beginSheetModal(for: window) { _ in completionHandler() }
            } else {
                alert.runModal()
                completionHandler()
            }
        #else
            guard let parent = bridgeViewController else { return completionHandler() }
            let alert = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            parent.present(alert, animated: true)
        #endif
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        #if os(macOS)
            let alert = NSAlert()
            alert.messageText = frame.request.url?.host ?? ""
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            if let window = webView.window {
                alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
            } else {
                completionHandler(alert.runModal() == .alertFirstButtonReturn)
            }
        #else
            guard let parent = bridgeViewController else { return completionHandler(false) }
            let alert = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            parent.present(alert, animated: true)
        #endif
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (String?) -> Void
    ) {
        #if os(macOS)
            let alert = NSAlert()
            alert.messageText = frame.request.url?.host ?? ""
            alert.informativeText = prompt
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
            field.stringValue = defaultText ?? ""
            alert.accessoryView = field
            if let window = webView.window {
                alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
            } else {
                completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
            }
        #else
            guard let parent = bridgeViewController else { return completionHandler(nil) }
            let alert = UIAlertController(title: frame.request.url?.host, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
            parent.present(alert, animated: true)
        #endif
    }
}
