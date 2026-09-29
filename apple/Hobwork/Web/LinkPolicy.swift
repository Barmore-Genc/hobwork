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
