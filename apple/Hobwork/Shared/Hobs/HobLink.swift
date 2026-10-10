import Foundation

/// `hobwork://open?hob=<hob>&path=<path>`: what widgets, Live Activities and intents open,
/// a page of a hob's UI at `/p/<hob><path>` in the web view.
struct HobLink: Equatable, Sendable {
    var hob: String
    /// Empty, or starting with `/`.
    var path: String

    /// A path without a leading `/` gets one.
    init?(hob: String, path: String?) {
        guard !hob.isEmpty, hob.count <= 64,
              hob.unicodeScalars.allSatisfy({ ("a" ... "z").contains($0) || ("0" ... "9").contains($0) || $0 == "-" })
        else { return nil }
        var path = path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !path.isEmpty, !path.hasPrefix("/") { path = "/" + path }
        self.hob = hob
        self.path = path
    }

    init?(url: URL) {
        guard url.scheme?.lowercased() == "hobwork", url.host()?.lowercased() == "open",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let hob = items.first(where: { $0.name == "hob" })?.value
        else { return nil }
        self.init(hob: hob, path: items.first(where: { $0.name == "path" })?.value)
    }

    var url: URL {
        var components = URLComponents()
        components.scheme = "hobwork"
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "hob", value: hob)] + (path.isEmpty ? [] : [URLQueryItem(name: "path", value: path)])
        return components.url!
    }

    /// The page in the Hobwork web UI.
    var webPath: String {
        "/p/\(hob)\(path)"
    }
}

/// Opens hob pages for intents that bring the app to the front. iOS refuses to open the
/// app's own `hobwork://` links from an intent, so the intent runs in the app and hands the
/// link to the app model here. A link from before the model is ready waits for it.
@MainActor
enum HobPageOpener {
    private static var handler: ((HobLink) -> Void)?
    private static var pending: HobLink?

    static func open(_ link: HobLink) {
        if let handler { handler(link) } else { pending = link }
    }

    static func setHandler(_ handler: @escaping (HobLink) -> Void) {
        self.handler = handler
        if let pending {
            self.pending = nil
            handler(pending)
        }
    }
}
