import Foundation
import Testing
@testable import Hobwork

@MainActor
@Suite struct DeviceConnectionTests {
    let factory = SocketFactory()
    let clock = ManualClock()
    let queue = MemoryEventQueue()
    let hello = Hello(appVersion: "1.0 (1)", platform: "ios", capabilities: ["notifications"], push: nil)

    func makeConnection() -> DeviceConnection {
        var request = URLRequest(url: URL(string: "wss://hobwork.example.com/api/devices/ws")!)
        request.setValue("Bearer hwd_test", forHTTPHeaderField: "Authorization")
        let clock = clock
        let factory = factory
        let hello = hello
        return DeviceConnection(
            request: request,
            hello: { hello },
            queue: queue,
            sleep: { try await clock.sleep(for: $0) },
            makeSocket: { factory.make($0) }
        )
    }

    func connected() async throws -> (DeviceConnection, FakeSocket) {
        let connection = makeConnection()
        connection.start()
        try await eventually("connected") { connection.state == .connected }
        return (connection, factory.last!)
    }

    @Test func sendsHelloWithTheDeviceToken() async throws {
        let (connection, socket) = try await connected()
        #expect(socket.sent == [.hello(hello)])
        #expect(factory.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer hwd_test")
        connection.stop()
        #expect(connection.state == .stopped)
        #expect(socket.cancelled)
    }

    @Test func answersCalls() async throws {
        let (connection, socket) = try await connected()
        let handler = RecordingHandler()
        handler.reply = { _, _ in .object(["id": .string("n1")]) }
        connection.register(handler, for: "notifications")

        try socket.deliver(.call(DeviceCall(id: .string("c1"), capability: "notifications", method: "send", args: .object(["title": .string("Hi")]))))
        try await eventually("result") { socket.sent.count == 2 }
        #expect(handler.calls.first?.method == "send")
        #expect(socket.sent.last == .result(DeviceCallResult(id: .string("c1"), outcome: .success(.object(["id": .string("n1")])))))
        connection.stop()
    }

    @Test func reportsHandlerErrors() async throws {
        let (connection, socket) = try await connected()
        let handler = RecordingHandler()
        handler.reply = { _, _ in throw CallError(code: "not_allowed", message: "Off") }
        connection.register(handler, for: "notifications")

        try socket.deliver(.call(DeviceCall(id: .number(7), capability: "notifications", method: "send", args: nil)))
        try await eventually("result") { socket.sent.count == 2 }
        #expect(socket.sent.last == .result(DeviceCallResult(id: .number(7), outcome: .failure(CallError(code: "not_allowed", message: "Off")))))
        connection.stop()
    }

    @Test func rejectsUnknownCapabilities() async throws {
        let (connection, socket) = try await connected()
        try socket.deliver(.call(DeviceCall(id: .string("c2"), capability: "nfc", method: "read", args: nil)))
        try await eventually("result") { socket.sent.count == 2 }
        guard case let .result(result) = socket.sent.last, case let .failure(error) = result.outcome else {
            Issue.record("expected a failed result")
            return
        }
        #expect(error.code == "unsupported")
        connection.stop()
    }

    @Test func answersPings() async throws {
        let (connection, socket) = try await connected()
        try socket.deliver(.ping)
        try await eventually("pong") { socket.sent.last == .pong }
        connection.stop()
    }

    @Test func ignoresUnknownAndMalformedMessages() async throws {
        let (connection, socket) = try await connected()
        socket.deliver(raw: #"{"type":"shiny-new-thing"}"#)
        socket.deliver(raw: "not json")
        try socket.deliver(.ping)
        try await eventually("pong") { socket.sent.last == .pong }
        #expect(connection.state == .connected)
        #expect(factory.sockets.count == 1)
        connection.stop()
    }

    @Test func pingsAndReconnectsAfterTwoMissedPongs() async throws {
        let (connection, socket) = try await connected()
        try await eventually("ping timer") { clock.pending == [.seconds(30)] }

        clock.advance(by: .seconds(30))
        try await eventually("first ping") { socket.sent.last == .ping }
        try await eventually("ping timer") { clock.pending == [.seconds(30)] }

        clock.advance(by: .seconds(30))
        try await eventually("second ping") { socket.sent.count == 3 }
        try await eventually("ping timer") { clock.pending == [.seconds(30)] }

        clock.advance(by: .seconds(30))
        try await eventually("gave up") { connection.state == .waiting(retryIn: .seconds(1)) }
        #expect(socket.cancelled)

        clock.advance(by: .seconds(1))
        try await eventually("reconnected") { connection.state == .connected && factory.sockets.count == 2 }
        #expect(factory.last?.sent == [.hello(hello)])
        connection.stop()
    }

    @Test func anyMessageCountsAsAlive() async throws {
        let (connection, socket) = try await connected()
        for _ in 0 ..< 4 {
            try await eventually("ping timer") { clock.pending == [.seconds(30)] }
            let count = socket.sent.count
            clock.advance(by: .seconds(30))
            try await eventually("ping") { socket.sent.count == count + 1 }
            try socket.deliver(.pong)
        }
        #expect(connection.state == .connected)
        #expect(factory.sockets.count == 1)
        connection.stop()
    }

    @Test func backsOffAndResetsAfterConnecting() async throws {
        factory.queued = (0 ..< 3).map { _ in FakeSocket(sendError: URLError(.cannotConnectToHost)) }
        let connection = makeConnection()
        connection.start()

        for seconds in [1, 2, 4] {
            try await eventually("waiting \(seconds)s") { connection.state == .waiting(retryIn: .seconds(seconds)) }
            clock.advance(by: .seconds(seconds))
        }
        try await eventually("connected") { connection.state == .connected }
        #expect(factory.sockets.count == 4)

        factory.last?.fail()
        try await eventually("waiting again") { connection.state == .waiting(retryIn: .seconds(1)) }
        connection.stop()
    }

    @Test func capsBackoff() {
        let connection = makeConnection()
        #expect(connection.backoff(0) == .seconds(1))
        #expect(connection.backoff(5) == .seconds(32))
        #expect(connection.backoff(6) == .seconds(60))
        #expect(connection.backoff(1000) == .seconds(60))
    }

    @Test func stopsWhenTheDeviceWasRevoked() async throws {
        factory.queued = [FakeSocket(sendError: DeviceSocketError.unauthorized)]
        let connection = makeConnection()
        var revoked = false
        connection.onUnauthorized = { revoked = true }
        connection.start()

        try await eventually("unauthorized") { connection.state == .unauthorized }
        #expect(revoked)
        #expect(clock.pending.isEmpty)
        #expect(factory.sockets.count == 1)
    }

    @Test func stopsWhenTheHostClosesForARemovedDevice() async throws {
        let (connection, socket) = try await connected()
        var revoked = false
        connection.onUnauthorized = { revoked = true }
        socket.fail(DeviceSocketError(closeCode: 4001)!)
        try await eventually("unauthorized") { connection.state == .unauthorized }
        #expect(revoked)
        #expect(factory.sockets.count == 1)
    }

    @Test func waitsLongestWhenReplaced() async throws {
        let (connection, socket) = try await connected()
        socket.fail(DeviceSocketError(closeCode: 4000)!)
        try await eventually("waiting") { connection.state == .waiting(retryIn: .seconds(60)) }
        connection.stop()
    }

    @Test func keepsTheTokenWhenTheOwnerIsNotAllowed() async throws {
        let (connection, socket) = try await connected()
        var revoked = false
        connection.onUnauthorized = { revoked = true }
        socket.fail(DeviceSocketError(closeCode: 4004)!)
        try await eventually("not allowed") { connection.state == .ownerNotAllowed(retryIn: .seconds(300)) }
        #expect(!revoked)

        clock.advance(by: .seconds(300))
        try await eventually("reconnected") { connection.state == .connected && factory.sockets.count == 2 }
        connection.stop()
    }

    @Test func keepsTheTokenWhenTheUpgradeIsForbidden() async throws {
        factory.queued = [FakeSocket(sendError: DeviceSocketError(upgradeStatus: 403)!)]
        let connection = makeConnection()
        var revoked = false
        connection.onUnauthorized = { revoked = true }
        connection.start()
        try await eventually("not allowed") { connection.state == .ownerNotAllowed(retryIn: .seconds(300)) }
        #expect(!revoked)
        connection.stop()
    }

    @Test func mapsUpgradeStatuses() {
        #expect(DeviceSocketError(upgradeStatus: 401) == .unauthorized)
        #expect(DeviceSocketError(upgradeStatus: 403) == .ownerNotAllowed)
        #expect(DeviceSocketError(upgradeStatus: 500) == nil)
    }

    @Test func mapsCloseCodes() {
        #expect(DeviceSocketError(closeCode: 4004) == .ownerNotAllowed)
        #expect(DeviceSocketError(closeCode: 4000) == .replaced)
        #expect(DeviceSocketError(closeCode: 4001) == .unauthorized)
        #expect(DeviceSocketError(closeCode: 4003) == nil)
        #expect(DeviceSocketError(closeCode: 1001) == nil)
    }

    @Test func reconnectSkipsTheBackoff() async throws {
        factory.queued = [FakeSocket(sendError: URLError(.notConnectedToInternet))]
        let connection = makeConnection()
        connection.start()
        try await eventually("waiting") { connection.state == .waiting(retryIn: .seconds(1)) }

        connection.reconnect()
        try await eventually("connected") { connection.state == .connected }
        #expect(factory.sockets.count == 2)
        try await eventually("old sleep cancelled") { clock.pending == [.seconds(30)] }
        connection.stop()
    }

    @Test func sendsQueuedEventsAfterHello() async throws {
        let event = DeviceEvent(capability: "notifications", name: "action", data: .object(["action": .string("reorder")]))
        queue.append(event)
        let (connection, socket) = try await connected()

        try await eventually("event sent") { socket.sent == [.hello(hello), .event(event)] }
        #expect(queue.events.isEmpty)
        connection.stop()
    }

    @Test func sendsEventsRightAwayWhenConnected() async throws {
        let (connection, socket) = try await connected()
        let event = DeviceEvent(capability: "notifications", name: "opened", data: .object([:]))
        connection.send(event)
        try await eventually("event sent") { socket.sent.last == .event(event) }
        #expect(queue.events.isEmpty)
        connection.stop()
    }

    @Test func keepsEventsWhileDisconnected() async throws {
        factory.queued = [FakeSocket(sendError: URLError(.notConnectedToInternet))]
        let connection = makeConnection()
        connection.start()
        try await eventually("waiting") { connection.state == .waiting(retryIn: .seconds(1)) }

        let event = DeviceEvent(capability: "notifications", name: "opened", data: .null)
        connection.send(event)
        #expect(queue.events == [event])

        clock.advance(by: .seconds(1))
        try await eventually("event sent") { factory.last?.sent == [.hello(hello), .event(event)] }
        #expect(queue.events.isEmpty)
        connection.stop()
    }
}
