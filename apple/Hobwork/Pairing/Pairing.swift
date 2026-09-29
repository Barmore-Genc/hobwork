import Foundation

/// One pairing attempt: the URL to open in `ASWebAuthenticationSession` and the checks
/// for its callback.
///
/// When the app is built with the host's domain in Associated Domains (`HOBWORK_APPLINKS_HOST`),
/// the callback is the universal link `https://<host>/devices/paired`, which only this app can
/// claim. Otherwise it is the custom scheme `hobwork://paired`, which any app can register.
struct Pairing: Sendable {
    static let callbackScheme = "hobwork"
    static let customSchemeRedirectURI = "hobwork://paired"
    static let pairedPath = "/devices/paired"

    /// What the session waits for: a custom scheme or an https link.
    enum Callback: Equatable, Sendable {
        case customScheme(String)
        case https(host: String, path: String)
    }

    /// The host name the app was built with in Associated Domains. macOS builds have none.
    static var bundledAppLinksHost: String? {
        #if os(iOS)
            let value = Bundle.main.object(forInfoDictionaryKey: "HobworkAppLinksHost") as? String
            return value?.isEmpty == false ? value : nil
        #else
            return nil
        #endif
    }

    let host: URL
    let deviceName: String
    let pkce: PKCE
    let state: String
    let callback: Callback
    let redirectURI: String

    init(
        host: URL,
        deviceName: String,
        appLinksHost: String? = Pairing.bundledAppLinksHost,
        pkce: PKCE = .random(),
        state: String = Base64URL.encode(randomBytes(16))
    ) {
        self.host = host
        self.deviceName = deviceName
        self.pkce = pkce
        self.state = state
        if let hostName = host.host()?.lowercased(), host.scheme == "https", appLinksHost?.lowercased() == hostName {
            var origin = URLComponents()
            origin.scheme = "https"
            origin.host = hostName
            origin.port = host.port
            origin.path = Self.pairedPath
            callback = .https(host: hostName, path: Self.pairedPath)
            redirectURI = origin.string!
        } else {
            callback = .customScheme(Self.callbackScheme)
            redirectURI = Self.customSchemeRedirectURI
        }
    }

    var url: URL {
        var components = URLComponents(url: host.appending(path: "devices/connect"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "name", value: deviceName),
            URLQueryItem(name: "platform", value: Hello.platform),
            URLQueryItem(name: "challenge", value: pkce.challenge),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
        ]
        // URLComponents leaves `+` alone in queries, which servers read as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url!
    }

    enum CallbackError: Error, Equatable, LocalizedError {
        case wrongRedirect
        case stateMismatch
        case denied(String)
        case missingCode

        var errorDescription: String? {
            switch self {
            case .wrongRedirect, .missingCode: "The host sent an unexpected response."
            case .stateMismatch: "The pairing response did not match this request. Try again."
            case let .denied(reason): reason == "access_denied" ? "Pairing was declined." : "Pairing failed: \(reason)"
            }
        }
    }

    /// Returns the code from the callback URL.
    func code(from callback: URL) throws(CallbackError) -> String {
        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              isExpected(components)
        else { throw .wrongRedirect }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw .stateMismatch }
        if let error = value("error") { throw .denied(error) }
        guard let code = value("code"), !code.isEmpty else { throw .missingCode }
        return code
    }

    private func isExpected(_ components: URLComponents) -> Bool {
        switch callback {
        case .customScheme:
            components.scheme == Self.callbackScheme && components.host == "paired"
        case let .https(host, path):
            components.scheme == "https" && components.host?.lowercased() == host.lowercased() && components.path == path
        }
    }
}
