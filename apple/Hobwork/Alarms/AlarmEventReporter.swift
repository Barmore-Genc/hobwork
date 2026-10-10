import Foundation

/// Tells hobs when their alarms ring, are stopped or repeated: from AlarmKit's updates while
/// the app runs, and from the Stop and repeat intents, which iOS runs in the app even when it
/// was not running. Each ring is reported once, `fired` before `stopped` or `repeated`.
@MainActor
final class AlarmEventReporter {
    /// What was last seen per alarm ID: an `AlarmState` raw value, or `answered` once Stop or
    /// repeat was reported for the current ring.
    nonisolated static let statesFile = SharedFile<[String: String]>(name: "alarm-states.json", empty: [:])
    private static let answered = "answered"

    struct Report: Equatable {
        var kind: AlarmEventKind
        var hob: String
        var data: JSONValue
    }

    private let records: SharedFile<[AlarmRecord]>
    private let states: SharedFile<[String: String]>
    private let deliver: (Report) async -> Void

    init(
        records: SharedFile<[AlarmRecord]> = AlarmsCapability.recordsFile,
        states: SharedFile<[String: String]> = AlarmEventReporter.statesFile,
        deliver: @escaping (Report) async -> Void
    ) {
        self.records = records
        self.states = states
        self.deliver = deliver
    }

    /// AlarmKit's current alarms.
    func observe(_ alarms: [ScheduledAlarm]) async {
        var reports: [(AlarmEventKind, UUID)] = []
        states.update { states in
            let current = Dictionary(alarms.map { ($0.id.uuidString.lowercased(), $0.state) }) { first, _ in first }
            for id in Set(states.keys).union(current.keys) {
                let previous = states[id]
                let now = current[id]
                guard let uuid = UUID(uuidString: id) else { continue }
                if now == .alerting {
                    if previous != AlarmState.alerting.rawValue { reports.append((.fired, uuid)) }
                } else if previous == AlarmState.alerting.rawValue {
                    reports.append((now == .countdown ? .repeated : .stopped, uuid))
                    states[id] = Self.answered
                    continue
                } else if previous == Self.answered {
                    // Kept until the next ring, so a late intent for this one is not reported again.
                    continue
                }
                states[id] = now?.rawValue
            }
        }
        for (kind, id) in reports { await report(kind, id) }
    }

    /// Stop or repeat, from the alarm's intents.
    func answered(_ kind: AlarmEventKind, id: UUID) async {
        let key = id.uuidString.lowercased()
        var reports: [AlarmEventKind] = []
        states.update { states in
            switch states[key] {
            case Self.answered?: return
            case AlarmState.alerting.rawValue?: reports = [kind]
            default: reports = [.fired, kind]
            }
            states[key] = Self.answered
        }
        for report in reports { await self.report(report, id) }
    }

    private func report(_ kind: AlarmEventKind, _ id: UUID) async {
        guard let record = records.read().first(where: { $0.uuid == id }), let hob = record.hob else { return }
        var data: [String: JSONValue] = ["id": .string(record.id.lowercased()), "title": .string(record.title)]
        if kind == .repeated, let seconds = record.repeatSeconds { data["seconds"] = .number(Double(seconds)) }
        await deliver(Report(kind: kind, hob: hob, data: .object(data)))
    }
}
