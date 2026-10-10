#if HOBWORK_DRIVER
    import Foundation
    import Network

    /// One HTTP request to the device driver. Header names are lowercased.
    struct DriverRequest: Sendable {
        var method: String
        var path: String
        var query: [String: String]
        var headers: [String: String]
        var body: Data

        var text: String { String(decoding: body, as: UTF8.self) }

        func number(_ name: String) -> Double? {
            query[name].flatMap(Double.init)
        }
    }

    struct DriverResponse: Sendable {
        var status: Int
        var contentType: String
        var body: Data
        var headers: [String: String] = [:]

        static func text(_ text: String, status: Int = 200) -> DriverResponse {
            DriverResponse(status: status, contentType: "text/plain; charset=utf-8", body: Data((text + "\n").utf8))
        }

        static func json(_ object: Any, status: Int = 200) -> DriverResponse {
            let body = (try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed, .sortedKeys]))
                ?? Data(#"{"error":"the result is not JSON"}"#.utf8)
            return DriverResponse(status: status, contentType: "application/json", body: body + Data("\n".utf8))
        }

        static func error(_ message: String, status: Int) -> DriverResponse {
            .json(["error": message], status: status)
        }
    }

    /// A small HTTP/1.1 server, one request per connection, that answers only requests with
    /// `Authorization: Bearer <token>`. It listens on one address only.
    final class DriverServer: @unchecked Sendable {
        typealias Handler = @Sendable (DriverRequest) async -> DriverResponse

        private static let maxRequest = 16 << 20

        private let listener: NWListener
        private let token: Data
        private let handler: Handler
        private let queue = DispatchQueue(label: "dev.bgenc.hobwork.driver")

        init(host: String, port: UInt16, token: String, handler: @escaping Handler) throws {
            guard let port = NWEndpoint.Port(rawValue: port) else { throw DriverServerError.badPort }
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: port)
            parameters.allowLocalEndpointReuse = true
            listener = try NWListener(using: parameters)
            self.token = Data("Bearer \(token)".utf8)
            self.handler = handler
        }

        func start() async throws {
            let resumed = Resumed()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if resumed.first() { continuation.resume() }
                    case let .failed(error), let .waiting(error):
                        if resumed.first() { continuation.resume(throwing: error) }
                    default:
                        break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
                listener.start(queue: queue)
            }
        }

        func stop() {
            listener.cancel()
        }

        private func accept(_ connection: NWConnection) {
            connection.start(queue: queue)
            receive(on: connection, buffer: Data())
        }

        private func receive(on connection: NWConnection, buffer: Data) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
                guard let self else { return connection.cancel() }
                var buffer = buffer
                if let data { buffer.append(data) }
                if buffer.count > Self.maxRequest { return self.send(.error("request too large", status: 413), on: connection) }
                switch Self.parse(buffer) {
                case let .complete(request):
                    self.respond(to: request, on: connection)
                case .incomplete where error == nil && !complete:
                    self.receive(on: connection, buffer: buffer)
                case .incomplete, .invalid:
                    self.send(.error("bad request", status: 400), on: connection)
                }
            }
        }

        private func respond(to request: DriverRequest, on connection: NWConnection) {
            guard Self.constantTimeEqual(Data((request.headers["authorization"] ?? "").utf8), token) else {
                return send(.error("missing or wrong token", status: 401), on: connection)
            }
            let handler = handler
            Task {
                let response = await handler(request)
                self.send(response, on: connection)
            }
        }

        private func send(_ response: DriverResponse, on connection: NWConnection) {
            var head = "HTTP/1.1 \(response.status) \(Self.reason(response.status))\r\n"
            head += "Content-Type: \(response.contentType)\r\nContent-Length: \(response.body.count)\r\nConnection: close\r\n"
            for (name, value) in response.headers { head += "\(name): \(value)\r\n" }
            head += "\r\n"
            connection.send(content: Data(head.utf8) + response.body, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }

        private enum Parsed {
            case complete(DriverRequest)
            case incomplete
            case invalid
        }

        private static func parse(_ buffer: Data) -> Parsed {
            guard let end = buffer.firstRange(of: Data("\r\n\r\n".utf8)) else { return .incomplete }
            let lines = String(decoding: buffer[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
            let parts = lines[0].split(separator: " ")
            guard parts.count == 3, let components = URLComponents(string: String(parts[1])) else { return .invalid }
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { return .invalid }
                headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            let length = Int(headers["content-length"] ?? "0") ?? -1
            guard length >= 0 else { return .invalid }
            let body = buffer[end.upperBound...]
            guard body.count >= length else { return .incomplete }
            var query: [String: String] = [:]
            for item in components.queryItems ?? [] { query[item.name] = item.value ?? "" }
            return .complete(DriverRequest(
                method: String(parts[0]),
                path: components.path,
                query: query,
                headers: headers,
                body: Data(body.prefix(length))
            ))
        }

        private static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
            guard a.count == b.count else { return false }
            return zip(a, b).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
        }

        private static func reason(_ status: Int) -> String {
            switch status {
            case 200: "OK"
            case 400: "Bad Request"
            case 401: "Unauthorized"
            case 404: "Not Found"
            case 409: "Conflict"
            case 413: "Content Too Large"
            default: "Error"
            }
        }
    }

    enum DriverServerError: Error {
        case badPort
    }

    private final class Resumed: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false

        func first() -> Bool {
            lock.withLock {
                defer { done = true }
                return !done
            }
        }
    }
#endif
