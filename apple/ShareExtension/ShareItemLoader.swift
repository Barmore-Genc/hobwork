import Foundation
import UniformTypeIdentifiers

/// Reads what the share sheet hands the extension. Files are copied into a folder of this
/// process: the system's copy only exists while its callback runs, and copying file to file
/// keeps large models out of memory.
@MainActor
enum ShareItemLoader {
    static func load(_ items: [NSExtensionItem], into folder: URL) async -> SharedItems {
        var url: URL?
        var text: String?
        var files: [SharedFileItem] = []
        let providers = items.flatMap { $0.attachments ?? [] }
        for provider in providers {
            if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                url = await loadURL(provider)
                if url != nil { continue }
            }
            if let type = fileType(of: provider), let file = await copyFile(provider, type: type, into: folder) {
                files.append(file)
                continue
            }
            if text == nil, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                text = await loadText(provider)
            }
        }
        return SharedItems(url: url, text: text, files: files)
    }

    /// The type to read a file as: anything stored as data, but not plain text or links, which
    /// travel as text and links.
    private static func fileType(of provider: NSItemProvider) -> UTType? {
        provider.registeredContentTypes.first { type in
            type.conforms(to: .data) && !type.conforms(to: .plainText) && !type.conforms(to: .url)
        }
    }

    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: NSURL.self) { value, _ in continuation.resume(returning: value as? URL) }
        }
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: NSString.self) { value, _ in continuation.resume(returning: value as? String) }
        }
    }

    private static func copyFile(_ provider: NSItemProvider, type: UTType, into folder: URL) async -> SharedFileItem? {
        let suggested = provider.suggestedName
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { source, _, _ in
                guard let source else { return continuation.resume(returning: nil) }
                let name = displayName(suggested: suggested, source: source, type: type)
                let target = folder.appending(path: UUID().uuidString, directoryHint: .isDirectory).appending(path: name)
                do {
                    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: source, to: target)
                    let size = (try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.intValue ?? 0
                    continuation.resume(returning: SharedFileItem(file: target, name: name, contentType: ShareMatch.mimeType(for: type, name: name), size: size))
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    /// The name the other app gave the file, with an extension.
    private nonisolated static func displayName(suggested: String?, source: URL, type: UTType) -> String {
        var name = suggested ?? source.lastPathComponent
        name = name.replacingOccurrences(of: "/", with: "-")
        if name.isEmpty { name = "Shared file" }
        if (name as NSString).pathExtension.isEmpty {
            let ext = source.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "") : source.pathExtension
            if !ext.isEmpty { name += ".\(ext)" }
        }
        return name
    }
}
