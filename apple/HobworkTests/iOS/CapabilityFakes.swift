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

    var endsAt: [UUID: Date] = [:]

    func alarms() throws -> [ScheduledAlarm] {
        states.map { ScheduledAlarm(id: $0.key, state: $0.value, endsAt: endsAt[$0.key]) }.sorted { $0.id.uuidString < $1.id.uuidString }
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
    var read = NFCTagRead(records: [], uid: "04a2245a8b6380")
    var failure: NFCSessionError?
    var written: [(URL, String?)] = []
    var sheets: [NFCSheet] = []
    var alerts: [String] = []
    var stopped: [String?] = []
    private(set) var onTag: (@MainActor (NFCTagRead) -> Void)?
    private(set) var onEnd: (@MainActor (NFCScanEnd) -> Void)?

    var records: [NFCRecord] {
        get { read.records }
        set { read.records = newValue }
    }

    func read(sheet: NFCSheet) async throws(NFCSessionError) -> NFCTagRead {
        sheets.append(sheet)
        if let failure { throw failure }
        return read
    }

    func write(url: URL, text: String?, sheet: NFCSheet) async throws(NFCSessionError) -> NFCTagRead {
        sheets.append(sheet)
        if let failure { throw failure }
        written.append((url, text))
        return read
    }

    func startScan(
        sheet: NFCSheet,
        keepOpen: Bool,
        onTag: @escaping @MainActor (NFCTagRead) -> Void,
        onEnd: @escaping @MainActor (NFCScanEnd) -> Void
    ) throws(NFCSessionError) {
        if let failure { throw failure }
        guard self.onEnd == nil else { throw .busy }
        sheets.append(sheet)
        self.onTag = onTag
        self.onEnd = onEnd
    }

    func updateScan(alertMessage: String) {
        alerts.append(alertMessage)
    }

    func stopScan(message: String?) {
        stopped.append(message)
        end(.stopped)
    }

    /// A tag held near the fake reader.
    func tag(_ read: NFCTagRead) {
        onTag?(read)
    }

    func end(_ reason: NFCScanEnd) {
        let onEnd = onEnd
        self.onTag = nil
        self.onEnd = nil
        onEnd?(reason)
    }
}
