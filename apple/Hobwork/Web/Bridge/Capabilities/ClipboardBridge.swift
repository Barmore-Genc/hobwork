#if os(macOS)
    import AppKit
#else
    import UIKit
    import UniformTypeIdentifiers
#endif

@MainActor
protocol Clipboard {
    /// On iOS, reading shows the system's "Allow Paste" prompt unless the person allowed
    /// Hobwork to paste from other apps.
    func read() -> (text: String?, url: URL?)
    func write(_ text: String)
    /// What the clipboard holds, without reading it, so iOS shows no prompt.
    func detect() async -> (url: Bool, text: Bool)
}

struct SystemClipboard: Clipboard {
    func read() -> (text: String?, url: URL?) {
        #if os(macOS)
            let board = NSPasteboard.general
            let url = board.readObjects(forClasses: [NSURL.self])?.first as? URL
            return (board.string(forType: .string), url)
        #else
            let board = UIPasteboard.general
            return (board.string, board.url)
        #endif
    }

    func write(_ text: String) {
        #if os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        #else
            UIPasteboard.general.string = text
        #endif
    }

    func detect() async -> (url: Bool, text: Bool) {
        #if os(macOS)
            let types = NSPasteboard.general.types ?? []
            return (types.contains(.URL), types.contains(.string))
        #else
            let board = UIPasteboard.general
            let probableURL: Bool = await withCheckedContinuation { continuation in
                board.detectPatterns(for: [.probableWebURL]) { result in
                    continuation.resume(returning: (try? result.get())?.contains(.probableWebURL) ?? false)
                }
            }
            return (board.hasURLs || probableURL, board.hasStrings)
        #endif
    }
}

#if os(iOS)
    /// A sheet with the system Paste button (`UIPasteControl`). The person tapping it is the
    /// consent, so iOS shows no "Allow Paste" prompt.
    @MainActor
    protocol PasteSheet {
        /// Nil when the person closed the sheet.
        func paste(title: String?, message: String?, presenter: any BridgePresenter) async throws -> (text: String?, url: URL?)?
    }

    struct SystemPasteSheet: PasteSheet {
        func paste(title: String?, message: String?, presenter: any BridgePresenter) async throws -> (text: String?, url: URL?)? {
            guard let parent = presenter.bridgeViewController else { throw BridgeError.unavailable("Nothing to show the paste sheet on") }
            return await withCheckedContinuation { continuation in
                let sheet = PasteViewController(title: title, message: message) { continuation.resume(returning: $0) }
                parent.present(sheet, animated: true)
            }
        }
    }

    private final class PasteViewController: UIViewController, UIAdaptivePresentationControllerDelegate {
        private let heading: String?
        private let message: String?
        private var finish: ((text: String?, url: URL?)?) -> Void

        init(title: String?, message: String?, finish: @escaping ((text: String?, url: URL?)?) -> Void) {
            heading = title
            self.message = message
            self.finish = finish
            super.init(nibName: nil, bundle: nil)
            pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.url.identifier, UTType.plainText.identifier])
            if let sheet = sheetPresentationController {
                sheet.detents = [.custom { _ in 210 }]
                sheet.prefersGrabberVisible = true
            }
            presentationController?.delegate = self
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .systemBackground
            let titleLabel = UILabel()
            titleLabel.text = heading ?? "Paste"
            titleLabel.font = .preferredFont(forTextStyle: .headline)
            titleLabel.textAlignment = .center
            let messageLabel = UILabel()
            messageLabel.text = message
            messageLabel.font = .preferredFont(forTextStyle: .subheadline)
            messageLabel.textColor = .secondaryLabel
            messageLabel.numberOfLines = 0
            messageLabel.textAlignment = .center
            messageLabel.isHidden = message == nil
            let configuration = UIPasteControl.Configuration()
            configuration.displayMode = .iconAndLabel
            configuration.cornerStyle = .capsule
            let control = UIPasteControl(configuration: configuration)
            control.target = self
            let cancel = UIButton(configuration: .plain(), primaryAction: UIAction(title: "Cancel") { [weak self] _ in
                self?.done(nil)
            })
            let stack = UIStackView(arrangedSubviews: [titleLabel, messageLabel, control, cancel])
            stack.axis = .vertical
            stack.alignment = .center
            stack.spacing = 14
            stack.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
                stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
                stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
                control.heightAnchor.constraint(equalToConstant: 44),
            ])
        }

        override func paste(itemProviders: [NSItemProvider]) {
            Task { @MainActor in
                done(await Self.contents(of: itemProviders))
            }
        }

        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            done(nil, dismiss: false)
        }

        private func done(_ contents: (text: String?, url: URL?)?, dismiss: Bool = true) {
            let finish = finish
            self.finish = { _ in }
            if dismiss { self.dismiss(animated: true) }
            finish(contents)
        }

        private static func contents(of providers: [NSItemProvider]) async -> (text: String?, url: URL?) {
            var text: String?
            var url: URL?
            for provider in providers {
                if url == nil, provider.canLoadObject(ofClass: NSURL.self) {
                    url = await withCheckedContinuation { continuation in
                        _ = provider.loadObject(ofClass: NSURL.self) { value, _ in continuation.resume(returning: value as? URL) }
                    }
                }
                if text == nil, provider.canLoadObject(ofClass: NSString.self) {
                    text = await withCheckedContinuation { continuation in
                        _ = provider.loadObject(ofClass: NSString.self) { value, _ in continuation.resume(returning: value as? String) }
                    }
                }
            }
            return (text ?? url?.absoluteString, url)
        }
    }
#endif

/// `clipboard.read`, `write`, `detect` and, on iOS, `paste`. Reading asks the person once per
/// hob, since the clipboard often holds things copied from other apps. `detect` reads nothing,
/// and `paste` only gets what the person pastes with the system Paste button.
@MainActor
final class ClipboardBridge: BridgeCapability {
    let name = "clipboard"
    #if os(iOS)
        let methods = ["read", "write", "detect", "paste"]
        private let pasteSheet: any PasteSheet
    #else
        let methods = ["read", "write", "detect"]
    #endif
    private let clipboard: any Clipboard

    #if os(iOS)
        init(clipboard: any Clipboard = SystemClipboard(), pasteSheet: any PasteSheet = SystemPasteSheet()) {
            self.clipboard = clipboard
            self.pasteSheet = pasteSheet
        }
    #else
        init(clipboard: any Clipboard = SystemClipboard()) {
            self.clipboard = clipboard
        }
    #endif

    func permission(for method: String) -> BridgePermission? {
        guard method == "read" else { return nil }
        return BridgePermission(
            key: "clipboard.read",
            label: "Read the clipboard",
            title: { "Let “\($0)” read your clipboard?" },
            message: "It can then read text and links you copy while it is open."
        )
    }

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        switch method {
        case "read":
            return Self.contents(clipboard.read())
        case "detect":
            let found = await clipboard.detect()
            return .object(["url": .bool(found.url), "text": .bool(found.text)])
        #if os(iOS)
            case "paste":
                guard let pasted = try await pasteSheet.paste(
                    title: try args.string("title"),
                    message: try args.string("message"),
                    presenter: context.presenter
                ) else { throw BridgeError.cancelled("Nothing was pasted") }
                return Self.contents(pasted)
        #endif
        default:
            clipboard.write(try args.string("text") ?? "")
            return .null
        }
    }

    private static func contents(_ value: (text: String?, url: URL?)) -> JSONValue {
        .object([
            "text": value.text.map(JSONValue.string) ?? .null,
            "url": value.url.map { .string($0.absoluteString) } ?? .null,
        ])
    }
}
