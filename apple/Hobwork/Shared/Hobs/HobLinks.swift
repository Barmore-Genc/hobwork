import Foundation

/// Which paths of a hob's origin open the app, as `GET /api/devices/hobs` lists them
/// (`appLinks`). iOS reads one `apple-app-site-association` for every hob (the apps host's),
/// so the app applies each hob's own rules itself.
struct HobLinkRules: Codable, Equatable, Sendable {
    var include: [String]
    var exclude: [String]

    /// For hobs the app has no rules for: every page, never the host's own paths.
    static let `default` = HobLinkRules(include: ["/*"], exclude: ["/api/*", "/_hobwork/*", "/theme/*", "/.well-known/*"])

    /// Exclusions win, as the first matching component of the association file does.
    func opensApp(path: String) -> Bool {
        let path = path.isEmpty ? "/" : path
        if exclude.contains(where: { Self.matches(path, $0) }) { return false }
        return include.contains(where: { Self.matches(path, $0) })
    }

    /// apple-app-site-association wildcards: `*` any characters, `?` one.
    static func matches(_ path: String, _ pattern: String) -> Bool {
        let text = Array(path)
        let glob = Array(pattern)
        var t = 0
        var g = 0
        var star: Int?
        var resume = 0
        while t < text.count {
            if g < glob.count, glob[g] == "?" || glob[g] == text[t] {
                t += 1
                g += 1
            } else if g < glob.count, glob[g] == "*" {
                star = g
                resume = t
                g += 1
            } else if let star {
                g = star + 1
                resume += 1
                t = resume
            } else {
                return false
            }
        }
        while g < glob.count, glob[g] == "*" { g += 1 }
        return g == glob.count
    }
}
