import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings

final class ManagedSettingsShields: ShieldControlling {
    func shield(store name: String, selection data: Data) {
        guard let selection = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data) else { return }
        let store = ManagedSettingsStore(named: .init(name))
        store.shield.applications = selection.applicationTokens.isEmpty ? nil : selection.applicationTokens
        store.shield.webDomains = selection.webDomainTokens.isEmpty ? nil : selection.webDomainTokens
        if selection.categoryTokens.isEmpty {
            store.shield.applicationCategories = nil
            store.shield.webDomainCategories = nil
        } else {
            store.shield.applicationCategories = .specific(selection.categoryTokens)
            store.shield.webDomainCategories = .specific(selection.categoryTokens)
        }
    }

    func clear(store name: String) {
        ManagedSettingsStore(named: .init(name)).clearAllSettings()
    }
}

final class DeviceActivityMonitoring: ActivityMonitoring {
    private let center = DeviceActivityCenter()
    static var limitEvent: DeviceActivityEvent.Name { DeviceActivityEvent.Name("limit") }

    var activities: [String] {
        center.activities.map(\.rawValue)
    }

    func start(_ activity: PlannedActivity, selection data: Data?) throws(ActivityMonitoringError) {
        let schedule = DeviceActivitySchedule(intervalStart: activity.start, intervalEnd: activity.end, repeats: activity.repeats)
        var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
        if let threshold = activity.threshold {
            let selection = data.flatMap { try? JSONDecoder().decode(FamilyActivitySelection.self, from: $0) } ?? FamilyActivitySelection()
            events[Self.limitEvent] = DeviceActivityEvent(
                applications: selection.applicationTokens,
                categories: selection.categoryTokens,
                webDomains: selection.webDomainTokens,
                threshold: threshold
            )
        }
        do {
            try center.startMonitoring(DeviceActivityName(activity.name.rawValue), during: schedule, events: events)
        } catch let error as DeviceActivityCenter.MonitoringError {
            switch error {
            case .intervalTooShort: throw .intervalTooShort
            case .intervalTooLong: throw .intervalTooLong
            case .excessiveActivities: throw .tooManyActivities
            case .unauthorized: throw .unauthorized
            default: throw .invalid
            }
        } catch {
            throw .invalid
        }
    }

    func stop(_ names: [String]) {
        guard !names.isEmpty else { return }
        center.stopMonitoring(names.map { DeviceActivityName($0) })
    }
}

enum ScreenTimeAuthorization {
    static var isApproved: Bool {
        guard AppGroup.hasFamilyControls else { return false }
        return switch AuthorizationCenter.shared.authorizationStatus {
        case .approved: true
        case .notDetermined, .denied: false
        default: true
        }
    }
}
