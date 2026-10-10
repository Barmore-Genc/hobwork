import Foundation
import Observation

/// The device WebSocket: hello on every connect, answers calls, sends events, pings
/// and reconnects with backoff until stopped.
@MainActor
@Observable
final class DeviceConnection {
    enum State: Equatable {
        case stopped
        case connecting
        case connected
        case waiting(retryIn: Duration)
        /// The owner may not sign in to the host right now; retrying slowly.
        case ownerNotAllowed(retryIn: Duration)
        /// The host rejected the device token. Stays here until started again.
        case unauthorized
    }

    struct Timing {
        var pingInterval: Duration = .seconds(30)
        /// The host drops a connection that misses two pings; the app does the same.
        var missedPingLimit = 2
        var initialBackoff: Duration = .seconds(1)
        var maxBackoff: Duration = .seconds(60)
        var ownerNotAllowedBackoff: Duration = .seconds(300)
    }

    private(set) var state: State = .stopped

    @ObservationIgnored var onUnauthorized: (() -> Void)?

    @ObservationIgnored private let request: URLRequest
    @ObservationIgnored private let makeSocket: @MainActor (URLRequest) -> any DeviceSocket
    @ObservationIgnored private let hello: @MainActor () -> Hello
    @ObservationIgnored private let queue: any EventQueue
    @ObservationIgnored private let sleep: Sleep
    @ObservationIgnored private let timing: Timing
    @ObservationIgnored let runner: CommandRunner

    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var socket: (any DeviceSocket)?
    @ObservationIgnored private var unansweredPings = 0
    @ObservationIgnored private var flushing = false

    init(
        request: URLRequest,
        hello: @escaping @MainActor () -> Hello,
        queue: any EventQueue,
        timing: Timing = Timing(),
        sleep: @escaping Sleep = { try await Task.sleep(for: $0) },
        runner: CommandRunner = CommandRunner(),
        makeSocket: @escaping @MainActor (URLRequest) -> any DeviceSocket = { URLSessionDeviceSocket(request: $0) }
    ) {
        self.request = request
        self.runner = runner
        self.hello = hello
        self.queue = queue
        self.timing = timing
        self.sleep = sleep
        self.makeSocket = makeSocket
    }

    func register(_ handler: any CapabilityHandler, for capability: String) {
        runner.register(handler, for: capability)
    }

    func start() {
        guard runTask == nil else { return }
        runTask = Task { await run() }
    }

    func stop() {
        runTask?.cancel()
        runTask = nil
        socket?.cancel()
        socket = nil
        state = .stopped
    }

    /// Drops any connection or pending retry and connects right away.
    func reconnect() {
        stop()
        start()
    }

    /// Says hello again on an open connection, so the host sees the app in use and its
    /// current time zone. Connecting says hello anyway.
    func sayHello() {
        guard state == .connected, let socket else { return }
        let message = hello()
        Task { try? await socket.send(DeviceMessage.hello(message).encoded()) }
    }

    /// Sends the event now when connected, otherwise on the next connect.
    func send(_ event: DeviceEvent) {
        queue.append(event)
        if state == .connected { Task { await flushEvents() } }
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            state = .connecting
            let socket = makeSocket(request)
            self.socket = socket
            var closedWith: DeviceSocketError?
            do {
                try await socket.send(DeviceMessage.hello(hello()).encoded())
                try Task.checkCancellation()
                attempt = 0
                unansweredPings = 0
                state = .connected
                try await serve(socket)
            } catch DeviceSocketError.unauthorized {
                socket.cancel()
                guard !Task.isCancelled else { return }
                self.socket = nil
                runTask = nil
                state = .unauthorized
                onUnauthorized?()
                return
            } catch let error as DeviceSocketError {
                closedWith = error
            } catch {}
            socket.cancel()
            guard !Task.isCancelled else { return }
            self.socket = nil
            switch closedWith {
            case .ownerNotAllowed:
                state = .ownerNotAllowed(retryIn: timing.ownerNotAllowedBackoff)
                do { try await sleep(timing.ownerNotAllowedBackoff) } catch { return }
            case .replaced:
                // Another copy of this device is connected. Reconnecting right away
                // would replace it and start a tug of war, so wait the longest delay.
                state = .waiting(retryIn: timing.maxBackoff)
                do { try await sleep(timing.maxBackoff) } catch { return }
            default:
                let delay = backoff(attempt)
                attempt += 1
                state = .waiting(retryIn: delay)
                do { try await sleep(delay) } catch { return }
            }
        }
    }

    func backoff(_ attempt: Int) -> Duration {
        min(timing.maxBackoff, timing.initialBackoff * (1 << min(attempt, 16)))
    }

    private func serve(_ socket: any DeviceSocket) async throws {
        Task { await flushEvents() }
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await self.receiveLoop(socket) }
            group.addTask { try await self.pingLoop(socket) }
            do {
                try await group.next()
            } catch {
                // A task blocked in receive() only returns once the socket closes.
                socket.cancel()
                throw error
            }
        }
    }

    private func receiveLoop(_ socket: any DeviceSocket) async throws {
        while true {
            let text = try await socket.receive()
            unansweredPings = 0
            guard let message = try? DeviceMessage.decode(text) else { continue }
            switch message {
            case .ping:
                try await socket.send(DeviceMessage.pong.encoded())
            case let .call(call):
                Task { await respond(to: call, on: socket) }
            default:
                break
            }
        }
    }

    private func pingLoop(_ socket: any DeviceSocket) async throws {
        while true {
            try await sleep(timing.pingInterval)
            if unansweredPings >= timing.missedPingLimit { throw DeviceSocketError.timedOut }
            unansweredPings += 1
            try await socket.send(DeviceMessage.ping.encoded())
        }
    }

    private func respond(to call: DeviceCall, on socket: any DeviceSocket) async {
        // Nil when another process runs the command right now; it answers the host itself.
        guard let outcome = await runner.run(DeviceCommand(call)) else { return }
        // A result for a connection that has since closed is lost; the host sends the
        // command again after the next hello and gets it from the command log.
        try? await socket.send(DeviceMessage.result(DeviceCallResult(id: call.id, outcome: outcome.result)).encoded())
    }

    private func flushEvents() async {
        guard !flushing else { return }
        flushing = true
        defer { flushing = false }
        while state == .connected, let socket, let event = queue.events.first {
            do {
                try await socket.send(DeviceMessage.event(event).encoded())
            } catch {
                return
            }
            queue.removeFirst()
        }
    }
}
