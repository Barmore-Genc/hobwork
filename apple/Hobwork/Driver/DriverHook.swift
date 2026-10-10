#if HOBWORK_DRIVER
    import Foundation
    import WebKit

    /// Lets the device driver's UI test run JavaScript in the web view and open URLs in it.
    /// Listens on the loopback address, and only when the test launched the app with
    /// `-hobworkDriverHookPort <port>` and a token in `HOBWORK_DRIVER_HOOK_TOKEN`.
    @MainActor
    enum DriverHook {
        static let portArgument = "-hobworkDriverHookPort"
        static let tokenVariable = "HOBWORK_DRIVER_HOOK_TOKEN"

        private static var server: DriverServer?

        static func start(web: WebController) {
            let arguments = ProcessInfo.processInfo.arguments
            guard let index = arguments.firstIndex(of: portArgument), index + 1 < arguments.count,
                  let port = UInt16(arguments[index + 1]),
                  let token = ProcessInfo.processInfo.environment[tokenVariable], token.count >= 32
            else { return }
            do {
                let server = try DriverServer(host: "127.0.0.1", port: port, token: token) { [weak web] request in
                    guard let web else { return .error("the web view is gone", status: 409) }
                    return await handle(request, web: web)
                }
                self.server = server
                Task {
                    do { try await server.start() } catch { print("driver hook: \(error)") }
                }
            } catch {
                print("driver hook: \(error)")
            }
        }

        private static func handle(_ request: DriverRequest, web: WebController) async -> DriverResponse {
            switch (request.method, request.path) {
            case ("GET", "/info"):
                return .json(["url": web.webView.url?.absoluteString as Any, "title": web.webView.title as Any])
            case ("POST", "/open"):
                guard let url = URL(string: request.text.trimmingCharacters(in: .whitespacesAndNewlines)),
                      url.scheme != nil
                else { return .error("not a URL", status: 400) }
                web.webView.load(URLRequest(url: url))
                return .json(["url": url.absoluteString])
            case ("POST", "/js"):
                return await evaluate(request.text, in: web.webView)
            case ("POST", "/js-async"):
                return await callAsync(request.text, in: web.webView)
            default:
                return .error("no such command", status: 404)
            }
        }

        /// The completion value of a script, as the console shows it.
        private static func evaluate(_ source: String, in webView: WKWebView) async -> DriverResponse {
            await withCheckedContinuation { continuation in
                webView.evaluateJavaScript(source) { value, error in
                    continuation.resume(returning: result(value, error))
                }
            }
        }

        /// The body of an async function, for scripts that `await` and `return`.
        private static func callAsync(_ source: String, in webView: WKWebView) async -> DriverResponse {
            await withCheckedContinuation { continuation in
                webView.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { outcome in
                    switch outcome {
                    case let .success(value): continuation.resume(returning: result(value, nil))
                    case let .failure(error): continuation.resume(returning: result(nil, error))
                    }
                }
            }
        }

        private static func result(_ value: Any?, _ error: Error?) -> DriverResponse {
            if let error {
                let info = (error as NSError).userInfo
                let message = info["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
                return .error(message, status: 422)
            }
            let value = value ?? NSNull()
            let wrapped: [String: Any] = ["result": value]
            if JSONSerialization.isValidJSONObject(wrapped) { return .json(wrapped) }
            return .json(["result": String(describing: value)])
        }
    }
#endif
