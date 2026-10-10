#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

@MainActor
protocol Clipboard {
    /// On iOS, reading shows the system's "Allow Paste" prompt unless the person allowed
    /// Hobwork to paste from other apps.
    func read() -> (text: String?, url: URL?)
    func write(_ text: String)
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
}

/// `clipboard.read` and `clipboard.write`. Reading asks the person once per hob, since
/// the clipboard often holds things copied from other apps.
@MainActor
final class ClipboardBridge: BridgeCapability {
    let name = "clipboard"
    let methods = ["read", "write"]
    private let clipboard: any Clipboard

    init(clipboard: any Clipboard = SystemClipboard()) {
        self.clipboard = clipboard
    }

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
            let (text, url) = clipboard.read()
            return .object([
                "text": text.map(JSONValue.string) ?? .null,
                "url": url.map { .string($0.absoluteString) } ?? .null,
            ])
        default:
            clipboard.write(try args.string("text") ?? "")
            return .null
        }
    }
}
