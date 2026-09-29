import Foundation

/// One pairing attempt: the URL to open in `ASWebAuthenticationSession` and the checks
/// for the `hobwork://paired` callback.
struct Pairing: Sendable {
    static let callbackScheme = "hobwork"
    static let redirectURI = "hobwork://paired"

    let host: URL
    let deviceName: String
    let pkce: PKCE
    let state: String

    init(host: URL, deviceName: String, pkce: PKCE = .random(), state: String = Base64URL.encode(randomBytes(16))) {
        self.host = host
        self.deviceName = deviceName
        self.pkce = pkce
        self.state = state
    }

    var url: URL {
        var components = URLComponents(url: host.appending(path: "devices/connect"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "name", value: deviceName),
            URLQueryItem(name: "platform", value: "ios"),
            URLQueryItem(name: "challenge", value: pkce.challenge),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
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
              components.scheme == Self.callbackScheme, components.host == "paired"
        else { throw .wrongRedirect }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw .stateMismatch }
        if let error = value("error") { throw .denied(error) }
        guard let code = value("code"), !code.isEmpty else { throw .missingCode }
        return code
    }
}
