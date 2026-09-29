import Observation
import UIKit
import WebKit

/// Owns the web view that shows the Hobwork web UI and project apps, and keeps it
/// signed in with one-time web session URLs from the host.
@MainActor
@Observable
final class WebController: NSObject {
    private(set) var loadError: String?
    private(set) var canGoBack = false

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private var policy: LinkPolicy?
    @ObservationIgnored private var requestWebSession: ((String) async throws -> URL)?
    @ObservationIgnored private var onUnauthorized: (() -> Void)?
    /// Sign-ins since the web view last had a session.
    @ObservationIgnored private var signInAttempts = 0
    @ObservationIgnored private var lastReturnTo = "/"
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []

    private static let sessionCookies: Set = ["hobwork_session", "__Host-hobwork_session"]

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self] _ in self?.refresh() }, for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        observations.append(webView.observe(\.canGoBack) { [weak self] webView, _ in
            MainActor.assumeIsolated { self?.canGoBack = webView.canGoBack }
        })
    }

    func configure(host: URL, requestWebSession: @escaping (String) async throws -> URL, onUnauthorized: @escaping () -> Void) {
        policy = LinkPolicy(host: host)
        self.requestWebSession = requestWebSession
        self.onUnauthorized = onUnauthorized
        signInAttempts = 0
        Task { await open(path: "/") }
    }

    /// Opens a Hobwork path, a project app or an outside link from a notification.
    func open(link: String) {
        guard let policy, let url = policy.url(forPath: link) else { return }
        if policy.opensInApp(url) {
            webView.load(URLRequest(url: url))
        } else {
            UIApplication.shared.open(url)
        }
    }

    func goHome() {
        Task { await open(path: "/") }
    }

    func goBack() {
        webView.goBack()
    }

    func refresh() {
        signInAttempts = 0
        if loadError != nil || webView.url == nil {
            Task { await open(path: currentPath ?? "/") }
        } else {
            webView.reload()
        }
    }

    /// The Hobwork session can end while the app is in the background.
    func checkSession() {
        guard let url = webView.url, let policy, url.host == policy.host.host else { return }
        Task { await checkSession(at: url) }
    }

    /// Clears cookies and storage, for signing out.
    func reset() async {
        policy = nil
        requestWebSession = nil
        onUnauthorized = nil
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
        let store = webView.configuration.websiteDataStore
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    private var currentPath: String? {
        guard let url = webView.url, let policy, url.host == policy.host.host else { return nil }
        return pathAndQuery(of: url)
    }

    private func open(path: String) async {
        guard let policy, let url = policy.url(forPath: path) else { return }
        loadError = nil
        if await hasSessionCookie() {
            webView.load(URLRequest(url: url))
        } else {
            await signIn(returnTo: path)
        }
    }

    private func signIn(returnTo path: String) async {
        guard let requestWebSession else { return }
        // A host that keeps sending the web view to sign-in would otherwise loop.
        guard signInAttempts < 3 else {
            loadError = "Couldn't sign in to Hobwork."
            return
        }
        signInAttempts += 1
        lastReturnTo = path
        do {
            let url = try await requestWebSession(path)
            loadError = nil
            webView.load(URLRequest(url: url))
        } catch HostError.unauthorized {
            onUnauthorized?()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func hasSessionCookie() async -> Bool {
        guard let host = policy?.host.host else { return false }
        let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        return cookies.contains { cookie in
            Self.sessionCookies.contains(cookie.name) && cookie.domain == host
                && (cookie.expiresDate.map { $0 > .now } ?? true)
        }
    }

    private func checkSession(at url: URL) async {
        let script = """
        const response = await fetch('/api/session', { credentials: 'same-origin' })
        if (!response.ok) return true
        return (await response.json()).user !== null
        """
        let signedIn = try? await webView.callAsyncJavaScript(script, contentWorld: .defaultClient) as? Bool
        if signedIn == true { signInAttempts = 0 }
        if signedIn == false { await signIn(returnTo: pathAndQuery(of: url)) }
    }

    private func pathAndQuery(of url: URL) -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "/" }
        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        return components.percentEncodedQuery.map { "\(path)?\($0)" } ?? path
    }

    private func failed(_ error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        let error = error as NSError
        // Cancelled loads, and loads the navigation policy handed elsewhere
        // (WebKitErrorFrameLoadInterruptedByPolicyChange), are not failures.
        if error.code == NSURLErrorCancelled || (error.domain == "WebKitErrorDomain" && error.code == 102) { return }
        loadError = error.localizedDescription
    }
}

extension WebController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        preferences: WKWebpagePreferences
    ) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        guard let url = action.request.url, let policy else { return (.allow, preferences) }
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "about", "blob", "data"].contains(scheme) else {
            await UIApplication.shared.open(url)
            return (.cancel, preferences)
        }
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        if mainFrame, let returnTo = policy.returnTo(forSignInPage: url, linkDestination: lastReturnTo) {
            Task { await signIn(returnTo: returnTo) }
            return (.cancel, preferences)
        }
        if mainFrame, action.navigationType == .linkActivated, !policy.opensInApp(url) {
            await UIApplication.shared.open(url)
            return (.cancel, preferences)
        }
        return (.allow, preferences)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
        loadError = nil
        checkSession()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

extension WebController: WKUIDelegate {
    /// Links with `target="_blank"` and `window.open`: Hobwork pages load here, the
    /// rest in Safari.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url {
            if policy?.opensInApp(url) == true {
                webView.load(action.request)
            } else {
                UIApplication.shared.open(url)
            }
        }
        return nil
    }
}
