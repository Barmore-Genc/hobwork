import Foundation
@testable import Hobwork

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
