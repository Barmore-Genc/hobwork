#if HOBWORK_DRIVER
    import Darwin
    import XCTest

    /// The device driver: serves a command API for `scripts/drive` while it runs. Skipped
    /// unless `scripts/drive start` runs it with a token.
    @MainActor
    final class DriverTests: XCTestCase {
        private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        private let app = XCUIApplication()
        private var issues: [String]?

        func testDrive() async throws {
            let environment = ProcessInfo.processInfo.environment
            let token = environment["HOBWORK_DRIVER_TOKEN"] ?? ""
            try XCTSkipIf(token.isEmpty, "Run with scripts/drive start")
            let address = try XCTUnwrap(environment["HOBWORK_DRIVER_ADDRESS"], "HOBWORK_DRIVER_ADDRESS is not set")
            let port = try XCTUnwrap(environment["HOBWORK_DRIVER_PORT"].flatMap(UInt16.init), "HOBWORK_DRIVER_PORT is not set")
            let minutes = environment["HOBWORK_DRIVER_MINUTES"].flatMap(Double.init) ?? 120
            try TunnelAddress.check(address)
            continueAfterFailure = true

            let hookPort = UInt16.random(in: 49152 ... 65000)
            let hookToken = Self.randomToken()
            app.launchArguments += ["-hobworkDriverHookPort", String(hookPort)]
            app.launchEnvironment["HOBWORK_DRIVER_HOOK_TOKEN"] = hookToken
            app.launch()

            let commands = CommandQueue()
            let hook = AppHook(port: hookPort, token: hookToken)
            let server = try DriverServer(host: address, port: port, token: token) { request in
                switch request.path {
                case "/js", "/js-async", "/open", "/web": await hook.forward(request)
                default: await commands.submit(request)
                }
            }
            try await server.start()
            defer { server.stop() }
            print("driver: listening on [\(address)]:\(port)")

            let deadline = Date.now.addingTimeInterval(minutes * 60)
            while Date.now < deadline {
                guard let (request, reply) = commands.next() else {
                    try await Task.sleep(for: .milliseconds(20))
                    continue
                }
                let response = perform(request)
                reply(response)
                if request.path == "/quit" { break }
            }
        }

        /// Failures of XCUITest calls are answered to the caller instead of failing the run.
        override func record(_ issue: XCTIssue) {
            if issues != nil {
                issues?.append(issue.compactDescription)
            } else {
                super.record(issue)
            }
        }

        private func perform(_ request: DriverRequest) -> DriverResponse {
            issues = []
            defer { issues = nil }
            let response = run(request)
            if let issues, !issues.isEmpty { return .error(issues.joined(separator: "\n"), status: 409) }
            return response
        }

        private func run(_ request: DriverRequest) -> DriverResponse {
            switch (request.method, request.path) {
            case ("GET", "/info"):
                let screenshot = XCUIScreen.main.screenshot()
                return .json([
                    "width": screenshot.image.size.width,
                    "height": screenshot.image.size.height,
                    "scale": screenshot.image.scale,
                    "foreground": app.state == .runningForeground,
                ])
            case ("GET", "/screenshot"):
                let screenshot = XCUIScreen.main.screenshot()
                return DriverResponse(status: 200, contentType: "image/png", body: screenshot.pngRepresentation)
            case ("POST", "/tap"):
                guard let x = request.number("x"), let y = request.number("y") else {
                    return .error("tap needs x and y", status: 400)
                }
                point(x, y).tap()
                return .json(["tapped": [x, y]])
            case ("POST", "/tap-label"):
                let label = request.text
                guard let element = element(labeled: label) else {
                    return .error("nothing labeled \(label) on screen", status: 404)
                }
                element.tap()
                return .json(["tapped": label])
            case ("POST", "/type"):
                foreground.typeText(request.text)
                return .json(["typed": request.text.count])
            case ("POST", "/swipe"):
                return swipe(request)
            case ("POST", "/home"):
                XCUIDevice.shared.press(.home)
                return .json(["pressed": "home"])
            case ("POST", "/activate"):
                app.activate()
                return .json(["activated": true])
            case ("GET", "/tree"):
                return .text(foreground.debugDescription)
            case ("POST", "/quit"):
                return .json(["quit": true])
            default:
                return .error("no such command", status: 404)
            }
        }

        /// The app while it is in front, otherwise the home screen.
        private var foreground: XCUIApplication {
            app.state == .runningForeground ? app : springboard
        }

        private func point(_ x: Double, _ y: Double) -> XCUICoordinate {
            foreground.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
        }

        /// System alerts and sheets belong to SpringBoard, so it is searched after the app.
        private func element(labeled label: String) -> XCUIElement? {
            let predicate = NSPredicate(format: "label == %@ OR identifier == %@", label, label)
            for target in [app, springboard] where target.state == .runningForeground || target == springboard {
                let matches = target.descendants(matching: .any).matching(predicate)
                if let hittable = matches.allElementsBoundByIndex.first(where: { $0.isHittable }) { return hittable }
            }
            return nil
        }

        private func swipe(_ request: DriverRequest) -> DriverResponse {
            if let direction = request.query["direction"] {
                switch direction {
                case "up": foreground.swipeUp()
                case "down": foreground.swipeDown()
                case "left": foreground.swipeLeft()
                case "right": foreground.swipeRight()
                default: return .error("direction is up, down, left or right", status: 400)
                }
                return .json(["swiped": direction])
            }
            guard let x1 = request.number("x1"), let y1 = request.number("y1"),
                  let x2 = request.number("x2"), let y2 = request.number("y2")
            else { return .error("swipe needs a direction or x1, y1, x2 and y2", status: 400) }
            let hold = request.number("hold") ?? 0.05
            point(x1, y1).press(forDuration: hold, thenDragTo: point(x2, y2))
            return .json(["swiped": [x1, y1, x2, y2]])
        }

        private static func randomToken() -> String {
            var bytes = [UInt8](repeating: 0, count: 32)
            _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            return bytes.map { String(format: "%02x", $0) }.joined()
        }
    }

    /// Requests from the network wait here until the test runs them on the main actor,
    /// since XCUITest calls must not overlap.
    private final class CommandQueue: @unchecked Sendable {
        typealias Reply = @Sendable (DriverResponse) -> Void

        private let lock = NSLock()
        private var pending: [(DriverRequest, Reply)] = []

        func submit(_ request: DriverRequest) async -> DriverResponse {
            await withCheckedContinuation { continuation in
                lock.withLock { pending.append((request, { continuation.resume(returning: $0) })) }
            }
        }

        func next() -> (DriverRequest, Reply)? {
            lock.withLock { pending.isEmpty ? nil : pending.removeFirst() }
        }
    }

    /// Forwards web view commands to the app's `DriverHook` on the loopback address.
    private struct AppHook: Sendable {
        let port: UInt16
        let token: String

        func forward(_ request: DriverRequest) async -> DriverResponse {
            let path = request.path == "/web" ? "/info" : request.path
            var urlRequest = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
            urlRequest.httpMethod = request.path == "/web" ? "GET" : "POST"
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if urlRequest.httpMethod == "POST" { urlRequest.httpBody = request.body }
            urlRequest.timeoutInterval = 30
            do {
                let (data, response) = try await URLSession.shared.data(for: urlRequest)
                let http = response as? HTTPURLResponse
                return DriverResponse(
                    status: http?.statusCode ?? 502,
                    contentType: http?.value(forHTTPHeaderField: "Content-Type") ?? "application/json",
                    body: data
                )
            } catch {
                return .error("the app did not answer: \(error.localizedDescription)", status: 502)
            }
        }
    }

    /// The driver listens only on the Mac's tunnel to the device: a unique local IPv6
    /// address (fc00::/7) on a point-to-point interface. Wi-Fi and cellular are refused.
    enum TunnelAddress {
        struct Refused: LocalizedError {
            let errorDescription: String?
        }

        static func check(_ address: String) throws {
            var parsed = in6_addr()
            guard inet_pton(AF_INET6, address, &parsed) == 1 else {
                throw Refused(errorDescription: "\(address) is not an IPv6 address")
            }
            guard (parsed.__u6_addr.__u6_addr8.0 & 0xFE) == 0xFC else {
                throw Refused(errorDescription: "\(address) is not a unique local address")
            }
            guard let interface = interface(owning: parsed) else {
                throw Refused(errorDescription: "no interface on this device has \(address)")
            }
            guard interface.pointToPoint, !interface.name.hasPrefix("en"), !interface.name.hasPrefix("pdp_ip") else {
                throw Refused(errorDescription: "\(address) is on \(interface.name), not the tunnel to the Mac")
            }
        }

        private static func interface(owning address: in6_addr) -> (name: String, pointToPoint: Bool)? {
            var list: UnsafeMutablePointer<ifaddrs>?
            guard getifaddrs(&list) == 0, let first = list else { return nil }
            defer { freeifaddrs(list) }
            var cursor: UnsafeMutablePointer<ifaddrs>? = first
            var target = address
            while let entry = cursor {
                defer { cursor = entry.pointee.ifa_next }
                guard let socket = entry.pointee.ifa_addr, socket.pointee.sa_family == UInt8(AF_INET6) else { continue }
                let matches = socket.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { pointer in
                    var own = pointer.pointee.sin6_addr
                    return memcmp(&own, &target, MemoryLayout<in6_addr>.size) == 0
                }
                if matches {
                    let flags = Int32(entry.pointee.ifa_flags)
                    return (String(cString: entry.pointee.ifa_name), flags & IFF_POINTOPOINT != 0)
                }
            }
            return nil
        }
    }
#endif
