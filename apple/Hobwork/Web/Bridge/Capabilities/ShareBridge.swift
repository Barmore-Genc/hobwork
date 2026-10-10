#if os(macOS)
    import AppKit
#else
    import UIKit
#endif
import Foundation

/// `share.show`: the share sheet for a file the hob made, a link or text.
@MainActor
final class ShareBridge: BridgeCapability {
    static let maxBytes = 50_000_000

    let name = "share"
    let methods = ["show"]

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        var items: [Any] = []
        var folder: URL?
        if let data = try args.data("data", limit: Self.maxBytes) {
            let directory = FileManager.default.temporaryDirectory.appending(path: "share/\(UUID().uuidString)", directoryHint: .isDirectory)
            let file = directory.appending(path: Self.filename(try args.string("filename")))
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: file)
            } catch {
                throw BridgeError.failed(error.localizedDescription)
            }
            folder = directory
            items.append(file)
        }
        if let link = try args.string("url") {
            guard let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
                throw BridgeError.failed("url must be an http or https link")
            }
            items.append(url)
        }
        if let text = try args.string("text") { items.append(text) }
        guard !items.isEmpty else { throw BridgeError.failed("Share needs data, url or text") }
        defer { if let folder { Self.remove(folder) } }
        let activity = try await show(items, presenter: context.presenter)
        return .object(["activity": activity.map(JSONValue.string) ?? .null])
    }

    /// On macOS the picker answers before the chosen service reads the file.
    private static func remove(_ folder: URL) {
        #if os(macOS)
            Task {
                try? await Task.sleep(for: .seconds(600))
                try? FileManager.default.removeItem(at: folder)
            }
        #else
            try? FileManager.default.removeItem(at: folder)
        #endif
    }

    /// The name the file is shared under: a single path component, never empty.
    static func filename(_ name: String?) -> String {
        let last = (name ?? "").split(separator: "/").last.map(String.init) ?? ""
        let cleaned = last.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        return cleaned.isEmpty ? "file" : String(last.prefix(200))
    }

    #if os(iOS)
        private func show(_ items: [Any], presenter: any BridgePresenter) async throws -> String? {
            guard let parent = presenter.bridgeViewController else { throw BridgeError.unavailable("Nothing to show the share sheet on") }
            let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let popover = sheet.popoverPresentationController, let view = presenter.bridgeView {
                popover.sourceView = view
                popover.sourceRect = PrintBridge.anchor(in: view)
            }
            return try await withCheckedThrowingContinuation { continuation in
                sheet.completionWithItemsHandler = { activity, completed, _, error in
                    if let error {
                        continuation.resume(throwing: BridgeError.failed(error.localizedDescription))
                    } else if completed {
                        continuation.resume(returning: activity?.rawValue)
                    } else {
                        continuation.resume(throwing: BridgeError.cancelled("Sharing was cancelled"))
                    }
                }
                parent.present(sheet, animated: true)
            }
        }
    #else
        private func show(_ items: [Any], presenter: any BridgePresenter) async throws -> String? {
            guard let view = presenter.bridgeView else { throw BridgeError.unavailable("Nothing to show the share menu on") }
            let picker = NSSharingServicePicker(items: items)
            let chooser = ServiceChooser()
            picker.delegate = chooser
            let service: String? = await withCheckedContinuation { continuation in
                chooser.continuation = continuation
                picker.show(relativeTo: CGRect(x: view.bounds.midX, y: view.bounds.minY, width: 1, height: 1), of: view, preferredEdge: .minY)
            }
            guard let service else { throw BridgeError.cancelled("Sharing was cancelled") }
            return service
        }

        @MainActor private final class ServiceChooser: NSObject, @preconcurrency NSSharingServicePickerDelegate {
            var continuation: CheckedContinuation<String?, Never>?

            func sharingServicePicker(_ picker: NSSharingServicePicker, didChoose service: NSSharingService?) {
                continuation?.resume(returning: service?.title)
                continuation = nil
            }
        }
    #endif
}
