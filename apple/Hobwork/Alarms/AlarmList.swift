import ActivityKit
import AlarmKit
import Foundation
import Observation

/// The alarms and timers Hobwork scheduled, kept current while the alarms screen is open.
@MainActor
@Observable
final class AlarmList {
    private(set) var items: [AlarmItem] = []
    /// Shown when an action on a row fails.
    var problem: String?

    @ObservationIgnored private let records: SharedFile<[AlarmRecord]>

    init(records: SharedFile<[AlarmRecord]> = AlarmsCapability.recordsFile) {
        self.records = records
    }

    func watch() async {
        if let alarms = try? AlarmManager.shared.alarms { update(alarms) }
        for await alarms in AlarmManager.shared.alarmUpdates {
            update(alarms)
        }
    }

    func perform(_ action: AlarmItem.Action, on item: AlarmItem) {
        let manager = AlarmManager.shared
        do {
            switch action {
            case .pause: try manager.pause(id: item.id)
            case .resume: try manager.resume(id: item.id)
            case .stop: try manager.stop(id: item.id)
            case .cancel:
                try manager.cancel(id: item.id)
                records.update { $0.removeAll { $0.uuid == item.id } }
            }
        } catch {
            problem = error.localizedDescription
        }
    }

    private func update(_ alarms: [Alarm]) {
        let titles = Dictionary(records.read().compactMap { record in record.uuid.map { ($0, record.title) } }) { first, _ in first }
        let progress = Dictionary(
            Activity<AlarmAttributes<HobworkAlarmMetadata>>.activities.compactMap { activity in
                let state = activity.content.state
                return AlarmItem.Progress(state.mode).map { (state.alarmID, $0) }
            }
        ) { first, _ in first }
        let now = Date()
        items = AlarmItem.sorted(alarms.map { alarm in
            AlarmItem(
                id: alarm.id,
                state: AlarmKitScheduler.state(alarm.state),
                schedule: alarm.schedule,
                duration: alarm.countdownDuration?.preAlert,
                title: titles[alarm.id],
                progress: progress[alarm.id],
                now: now
            )
        })
    }
}
