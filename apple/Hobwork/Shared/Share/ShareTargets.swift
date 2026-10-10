import Foundation
import UniformTypeIdentifiers

/// A file from the share sheet, copied to a file this process owns so it is uploaded from
/// disk and never held in memory.
struct SharedFileItem: Equatable, Sendable {
    var file: URL
    /// The name in the app it came from.
    var name: String
    var contentType: String?
    var size: Int
}

/// What someone shared: at most one link, text and files.
struct SharedItems: Equatable, Sendable {
    var url: URL?
    var text: String?
    var files: [SharedFileItem]

    /// Text that is only a web link counts as the link, as Notes and Messages share links.
    init(url: URL? = nil, text: String? = nil, files: [SharedFileItem] = []) {
        var url = url.flatMap { Self.webLink($0.absoluteString) }
        var text = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        if text?.isEmpty == true { text = nil }
        if url == nil, let link = text.flatMap(Self.webLink) {
            url = link
            text = nil
        }
        if let shown = text, shown == url?.absoluteString { text = nil }
        self.url = url
        self.text = text
        self.files = files
    }

    var isEmpty: Bool {
        url == nil && text == nil && files.isEmpty
    }

    private static func webLink(_ string: String) -> URL? {
        guard !string.contains(where: \.isWhitespace), let url = URL(string: string),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host() != nil
        else { return nil }
        return url
    }
}

/// A share target of one hob, as the share sheet lists it.
struct ShareOption: Equatable, Identifiable, Sendable {
    var hob: String
    var target: HostShareTarget

    var id: String { "\(hob)/\(target.id)" }
}

/// What a target gets of the shared items.
struct SharePayload: Equatable, Sendable {
    var url: URL?
    var text: String?
    var files: [SharedFileItem]
}

enum ShareMatch {
    /// Targets that take something of what was shared, in the host's order.
    static func options(hobs: [HostHob], items: SharedItems) -> [ShareOption] {
        hobs.flatMap { hob in
            (hob.share ?? []).map { ShareOption(hob: hob.hob, target: $0) }.filter { payload(for: $0.target, items: items) != nil }
        }
    }

    /// Nil when the target takes nothing of it. Files the target does not take are left out.
    static func payload(for target: HostShareTarget, items: SharedItems) -> SharePayload? {
        let files = target.accepts.files.isEmpty ? [] : items.files.filter { accepts(target.accepts.files, name: $0.name, contentType: $0.contentType) }
        let url = target.accepts.urls ? items.url : nil
        var text = target.accepts.text ? items.text : nil
        // A target for text gets a link as text when it takes no links.
        if text == nil, url == nil, target.accepts.text, let link = items.url { text = link.absoluteString }
        guard url != nil || text != nil || !files.isEmpty else { return nil }
        return SharePayload(url: url, text: text, files: files)
    }

    /// Why the target cannot take the files, worded for the person sharing.
    static func problem(for target: HostShareTarget, payload: SharePayload) -> String? {
        guard let max = target.maxBytes, let big = payload.files.first(where: { $0.size > max }) else { return nil }
        let limit = ByteCountFormatter.string(fromByteCount: Int64(max), countStyle: .file)
        return "\(big.name) is too large. \(target.title) takes files up to \(limit)."
    }

    /// As the host matches upload types: an extension against the name, a MIME type (or
    /// `type/*`) against the content type.
    static func accepts(_ types: [String], name: String, contentType: String?) -> Bool {
        let name = name.lowercased()
        let type = (contentType ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        return types.contains { allowed in
            let pattern = allowed.lowercased()
            if pattern.hasPrefix(".") { return name.hasSuffix(pattern) }
            if pattern.hasSuffix("/*") { return type.hasPrefix(String(pattern.dropLast())) }
            return type == pattern
        }
    }

    /// The MIME type for a file: the type it was shared as, else what its extension says.
    static func mimeType(for type: UTType?, name: String) -> String? {
        if let mime = type?.preferredMIMEType { return mime }
        let ext = (name as NSString).pathExtension.lowercased()
        if let mime = UTType(filenameExtension: ext)?.preferredMIMEType { return mime }
        return ["3mf": "model/3mf", "stl": "model/stl", "obj": "model/obj"][ext]
    }
}

/// The target picked last, offered first next time.
struct ShareChoiceStore {
    static let key = "share.lastTarget"
    var defaults: UserDefaults = AppGroup.defaults

    func preferred(in options: [ShareOption]) -> ShareOption? {
        let last = defaults.string(forKey: Self.key)
        return options.first { $0.id == last } ?? options.first
    }

    func remember(_ option: ShareOption) {
        defaults.set(option.id, forKey: Self.key)
    }
}

/// The hob list as the share sheet last saw it, so targets show at once while it asks the host
/// again.
struct ShareCatalogCache {
    struct Stored: Codable, Sendable {
        var host: URL?
        var hobs: [HostHob]
    }

    var file = SharedFile(name: "share-targets.json", empty: Stored(host: nil, hobs: []))

    func hobs(for host: URL) -> [HostHob] {
        let stored = file.read()
        return stored.host == host ? stored.hobs : []
    }

    func save(_ hobs: [HostHob], for host: URL) {
        file.update { $0 = Stored(host: host, hobs: hobs) }
    }
}
