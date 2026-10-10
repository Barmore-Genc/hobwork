import Foundation

/// Decides which pages stay in the app: the Hobwork host and its project apps.
struct LinkPolicy: Sendable {
    let host: URL

    func opensInApp(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let target = url.host?.lowercased(), let hobwork = host.host?.lowercased()
        else { return false }
        if target == hobwork || target.hasSuffix("." + hobwork) { return true }
        // Project apps are `<project>.<apps host>`. The apps host defaults to
        // `apps.<Hobwork host>`, covered above, but can also be a sibling such as
        // `apps.example.com` next to `hobwork.example.com`.
        let parent = hobwork.split(separator: ".").dropFirst().joined(separator: ".")
        guard !parent.isEmpty, parent.contains(".") || parent == "localhost" else { return false }
        let labels = target.split(separator: ".")
        return labels.count >= 3 && labels[1] == "apps" && labels.dropFirst(2).joined(separator: ".") == parent
    }

    /// The hosts that hob app origins are one label below: `apps.<Hobwork host>`, or a
    /// sibling such as `apps.example.com` next to `hobwork.example.com`.
    var appsHosts: [String] {
        guard let hobwork = host.host?.lowercased() else { return [] }
        let parent = hobwork.split(separator: ".").dropFirst().joined(separator: ".")
        guard !parent.isEmpty, parent.contains(".") || parent == "localhost" else { return ["apps." + hobwork] }
        return ["apps." + hobwork, "apps." + parent]
    }

    /// The hob whose app (or branch preview) is served at this origin, or nil for the
    /// Hobwork origin and every other site. Ports are not compared: in development the
    /// web UI and the apps are served on different ports.
    func hobOrigin(scheme: String, host target: String, port: Int?) -> HobOrigin? {
        let scheme = scheme.lowercased()
        guard scheme == host.scheme?.lowercased() else { return nil }
        let target = target.lowercased()
        for apps in appsHosts where target.hasSuffix("." + apps) {
            let label = String(target.dropLast(apps.count + 1))
            guard !label.isEmpty, !label.contains(".") else { continue }
            // Hob names never contain `--`, so the last one ends a branch label.
            let (branch, hob): (String?, String) = if let range = label.range(of: "--", options: .backwards) {
                (String(label[..<range.lowerBound]), String(label[range.upperBound...]))
            } else {
                (nil, label)
            }
            guard !hob.isEmpty, branch?.isEmpty != true else { return nil }
            return HobOrigin(scheme: scheme, host: target, port: port, hob: hob, branch: branch, appsHost: apps)
        }
        return nil
    }

    func hobOrigin(of url: URL) -> HobOrigin? {
        guard let scheme = url.scheme, let host = url.host() else { return nil }
        return hobOrigin(scheme: scheme, host: host, port: url.port)
    }

    /// The Hobwork sign-in page, which the web view never needs: the app signs it in.
    func isSignInPage(_ url: URL) -> Bool {
        url.host?.lowercased() == host.host?.lowercased() && url.path == "/login"
    }

    /// Where to go after signing in, when `url` is the sign-in page. A used or expired
    /// sign-in link lands there without a destination, so that falls back to where the
    /// link was headed.
    func returnTo(forSignInPage url: URL, linkDestination: String) -> String? {
        guard isSignInPage(url) else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let returnTo = items.first(where: { $0.name == "returnTo" })?.value, returnTo.hasPrefix("/"), !returnTo.hasPrefix("//") {
            return returnTo
        }
        if items.contains(where: { $0.name == "error" && $0.value == "link_expired" }) { return linkDestination }
        return "/"
    }

    func url(forPath path: String) -> URL? {
        URL(string: path, relativeTo: host)?.absoluteURL
    }
}

/// A hob's app origin: `<hob>.<apps host>`, or `<branch label>--<hob>.<apps host>` for a
/// branch preview.
struct HobOrigin: Hashable, Sendable {
    var scheme: String
    var host: String
    var port: Int?
    var hob: String
    var branch: String?
    var appsHost: String

    var string: String {
        port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }

    /// What the person's choices are remembered under. Branch previews share them with the
    /// hob, since they are the same hob's code.
    var permissionKey: String {
        "\(appsHost)/\(hob)"
    }
}
