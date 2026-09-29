import Foundation
@testable import Hobwork

/// A socket the test plays the host side of.
final class FakeSocket: DeviceSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [Result<String, Error>] = []
    private var waiter: CheckedContinuation<String, Error>?
    private var _sent: [String] = []
    private var _cancelled = false
    private let sendError: Error?

    init(sendError: Error? = nil) {
        self.sendError = sendError
    }

    var sent: [DeviceMessage] {
        lock.withLock { _sent }.compactMap { try? DeviceMessage.decode($0) }
    }

    var cancelled: Bool {
        lock.withLock { _cancelled }
    }

    func send(_ text: String) async throws {
        try lock.withLock {
            if _cancelled { throw DeviceSocketError.closed }
            if let sendError { throw sendError }
            _sent.append(text)
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock {
                if !inbox.isEmpty {
                    continuation.resume(with: inbox.removeFirst())
                } else if _cancelled {
                    continuation.resume(throwing: DeviceSocketError.closed)
                } else {
                    waiter = continuation
                }
            }
        }
    }

    func cancel() {
        let waiter = lock.withLock {
            _cancelled = true
            defer { self.waiter = nil }
            return self.waiter
        }
        waiter?.resume(throwing: DeviceSocketError.closed)
    }

    /// The host sends a message.
    func deliver(_ message: DeviceMessage) throws {
        push(.success(try message.encoded()))
    }

    func deliver(raw text: String) {
        push(.success(text))
    }

    /// The connection drops.
    func fail(_ error: Error = DeviceSocketError.closed) {
        push(.failure(error))
    }

    private func push(_ result: Result<String, Error>) {
        let waiter = lock.withLock {
            if let waiter = self.waiter {
                self.waiter = nil
                return Optional(waiter)
            }
            inbox.append(result)
            return nil
        }
        waiter?.resume(with: result)
    }
}

/// Hands out sockets for each connection attempt and records the requests.
@MainActor
final class SocketFactory {
    private(set) var sockets: [FakeSocket] = []
    private(set) var requests: [URLRequest] = []
    /// Sockets to use for the next attempts, before falling back to working ones.
    var queued: [FakeSocket] = []

    func make(_ request: URLRequest) -> any DeviceSocket {
        requests.append(request)
        let socket = queued.isEmpty ? FakeSocket() : queued.removeFirst()
        sockets.append(socket)
        return socket
    }

    var last: FakeSocket? { sockets.last }
}

/// A clock the test advances by hand, so ping and backoff timing need no real waiting.
final class ManualClock: @unchecked Sendable {
    private struct Sleeper {
        var id: UUID
        var deadline: Duration
        var continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var now: Duration = .zero
    private var sleepers: [Sleeper] = []

    var pending: [Duration] {
        lock.withLock { sleepers.map { $0.deadline - now } }
    }

    func sleep(for duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                self.add(id: id, duration: duration, continuation: continuation)
            }
        } onCancel: {
            self.cancel(id: id)
        }
    }

    private func add(id: UUID, duration: Duration, continuation: CheckedContinuation<Void, Error>) {
        lock.lock()
        defer { lock.unlock() }
        if Task.isCancelled {
            continuation.resume(throwing: CancellationError())
        } else {
            sleepers.append(Sleeper(id: id, deadline: now + duration, continuation: continuation))
        }
    }

    private func cancel(id: UUID) {
        lock.lock()
        let index = sleepers.firstIndex { $0.id == id }
        let sleeper = index.map { sleepers.remove(at: $0) }
        lock.unlock()
        sleeper?.continuation.resume(throwing: CancellationError())
    }

    func advance(by duration: Duration) {
        let due = lock.withLock {
            now += duration
            let due = sleepers.filter { $0.deadline <= now }
            sleepers.removeAll { $0.deadline <= now }
            return due
        }
        for sleeper in due { sleeper.continuation.resume() }
    }
}

/// Polls until the condition holds, giving the connection's tasks time to run.
@MainActor
func eventually(
    _ description: String = "condition",
    timeout: Duration = .seconds(2),
    _ condition: @MainActor () -> Bool
) async throws {
    let start = ContinuousClock.now
    while !condition() {
        if ContinuousClock.now - start > timeout { throw TimedOut(description: description) }
        try await Task.sleep(for: .milliseconds(1))
    }
}

struct TimedOut: Error, CustomStringConvertible {
    var description: String
}

@MainActor
final class RecordingHandler: CapabilityHandler {
    var calls: [(method: String, args: JSONValue?)] = []
    var reply: @MainActor (String, JSONValue?) throws -> JSONValue = { _, _ in .null }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        calls.append((method, args))
        return try reply(method, args)
    }
}

func temporaryFile<Value: Codable & Sendable>(_ empty: Value) -> SharedFile<Value> {
    SharedFile(url: FileManager.default.temporaryDirectory.appending(path: "hobwork-tests/\(UUID().uuidString).json"), empty: empty)
}

/// 2026-05-04 is a Monday.
func isoDate(_ text: String) -> Date {
    ISODate.parse(text)!
}

var utcCalendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
}

@MainActor
final class FakeAlarmScheduler: AlarmScheduling {
    var isAuthorized = true
    var scheduled: [AlarmRecord] = []
    var cancelled: [UUID] = []
    var states: [UUID: AlarmState] = [:]
    var failure: AlarmSchedulingError?

    func schedule(_ alarm: AlarmRecord) async throws {
        if let failure { throw failure }
        scheduled.append(alarm)
        states[alarm.uuid!] = alarm.seconds == nil ? .scheduled : .countdown
    }

    func cancel(_ id: UUID) {
        cancelled.append(id)
        states[id] = nil
    }

    func alarms() throws -> [(id: UUID, state: AlarmState)] {
        states.map { ($0.key, $0.value) }.sorted { $0.0.uuidString < $1.0.uuidString }
    }
}

final class FakeShields: ShieldControlling {
    var shielded: [String: Data] = [:]
    var log: [String] = []

    func shield(store: String, selection: Data) {
        shielded[store] = selection
        log.append("shield \(store)")
    }

    func clear(store: String) {
        shielded[store] = nil
        log.append("clear \(store)")
    }
}

final class FakeActivityMonitoring: ActivityMonitoring {
    var started: [String: PlannedActivity] = [:]
    var selections: [String: Data] = [:]
    var failure: ActivityMonitoringError?

    var activities: [String] { started.keys.sorted() }

    func start(_ activity: PlannedActivity, selection: Data?) throws(ActivityMonitoringError) {
        if let failure { throw failure }
        started[activity.name.rawValue] = activity
        selections[activity.name.rawValue] = selection
    }

    func stop(_ names: [String]) {
        for name in names { started[name] = nil }
    }
}

@MainActor
final class FakeHealthReader: HealthReading {
    var samples: [HealthSample] = []
    var failure: HealthReadError?
    var queries: [(HealthType, Date, Date, Int)] = []

    func samples(of type: HealthType, from: Date, to: Date, limit: Int) async throws(HealthReadError) -> [HealthSample] {
        queries.append((type, from, to, limit))
        if let failure { throw failure }
        return samples
    }
}

@MainActor
final class FakeNFCSession: NFCTagSession {
    var isAvailable = true
    var records: [NFCRecord] = []
    var failure: NFCSessionError?
    var written: [(URL, String?)] = []

    func read() async throws(NFCSessionError) -> [NFCRecord] {
        if let failure { throw failure }
        return records
    }

    func write(url: URL, text: String?) async throws(NFCSessionError) {
        if let failure { throw failure }
        written.append((url, text))
    }
}

/// Parses a JSON literal, for call arguments.
func json(_ text: String) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}
