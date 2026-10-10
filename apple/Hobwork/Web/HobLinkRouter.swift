import Foundation

#if os(iOS)
    /// What the app does with a link to a hob's origin that opened it (a universal link).
    enum HobLinkAction: Equatable {
        /// A page of the hob listens: it gets `link.opened` and the app stays on it.
        case deliver(HobOrigin, JSONValue)
        /// A page of the hob listens for scans only, as before links opened the app.
        case scanned
        /// Load it in the web view.
        case load(URL)
        /// The hob keeps this path out of the app: show it in Safari.
        case browser(URL)
    }

    enum HobLinkRouter {
        static func action(for url: URL, origin: HobOrigin, rules: HobLinkRules, listens: (String) -> Bool) -> HobLinkAction {
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let path = components?.percentEncodedPath ?? url.path
            guard rules.opensApp(path: path.isEmpty ? "/" : path) else { return .browser(url) }
            if listens("link.opened") {
                let full = (path.isEmpty ? "/" : path) + (components?.percentEncodedQuery.map { "?\($0)" } ?? "")
                return .deliver(origin, .object(["url": .string(url.absoluteString), "path": .string(full)]))
            }
            if listens("nfc.scanned") { return .scanned }
            return .load(url)
        }
    }

    /// Link rules of the paired host's hobs, fetched with the hob list and kept for a while, so
    /// opening a link does not wait for the host every time.
    @MainActor
    final class HobLinkRulesCache {
        static let maxAge: TimeInterval = 5 * 60

        private var rules: [String: HobLinkRules] = [:]
        private var fetchedAt: Date?
        private var host: URL?

        /// The hob's rules; the defaults when the host cannot be reached or does not list it.
        func rules(for hob: String, host: URL, fetch: () async throws -> [HostHob]) async -> HobLinkRules {
            let stale = fetchedAt.map { Date().timeIntervalSince($0) > Self.maxAge } ?? true
            if stale || host != self.host, let hobs = try? await fetch() {
                rules = Dictionary(hobs.compactMap { hob in hob.appLinks.map { (hob.hob, $0) } }, uniquingKeysWith: { first, _ in first })
                fetchedAt = Date()
                self.host = host
            }
            guard host == self.host else { return .default }
            return rules[hob] ?? .default
        }
    }
#endif
