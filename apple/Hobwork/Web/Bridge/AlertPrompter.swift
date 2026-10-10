#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// Asks with a system alert over the web view.
@MainActor
struct AlertPrompter: BridgePrompter {
    func ask(title: String, message: String, presenter: any BridgePresenter) async -> Bool? {
        #if os(macOS)
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            alert.addButton(withTitle: "Allow")
            alert.addButton(withTitle: "Don’t Allow")
            guard let window = presenter.bridgeWindow else { return alert.runModal() == .alertFirstButtonReturn }
            return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
        #else
            guard let parent = presenter.bridgeViewController else { return nil }
            return await withCheckedContinuation { continuation in
                let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Don’t Allow", style: .cancel) { _ in continuation.resume(returning: false) })
                alert.addAction(UIAlertAction(title: "Allow", style: .default) { _ in continuation.resume(returning: true) })
                parent.present(alert, animated: true)
            }
        #endif
    }
}
