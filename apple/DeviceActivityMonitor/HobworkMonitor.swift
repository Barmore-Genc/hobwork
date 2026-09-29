import DeviceActivity
import Foundation

/// Applies and lifts shields for Screen Time schedules, daily limits and timed blocks. iOS
/// runs it at the start and end of each interval, even when the app is not running.
final class HobworkMonitor: DeviceActivityMonitor {
    private let shields = ManagedSettingsShields()

    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        handle(.intervalStart, activity: activity)
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        handle(.intervalEnd, activity: activity)
    }

    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)
        handle(.threshold, activity: activity)
    }

    private func handle(_ event: MonitorEvent, activity: DeviceActivityName) {
        let shields = shields
        ScreenTimeState.file.update { state in
            let actions = ScreenTimePlan.actions(for: event, activity: activity.rawValue, state: state)
            ScreenTimePlan.perform(actions, shields: shields, state: &state, now: Date())
        }
    }
}
