import AlarmKit
import CoreNFC
import FamilyControls
import HealthKit
import UserNotifications

/// Whether each capability is set up and allowed on this device. `hello` lists only those,
/// so the host refuses calls that could not work.
struct CapabilityStatus: Equatable, Sendable {
    var notifications = false
    var alarms = false
    var screenTime = false
    var focus = false
    var nfc = false
    var health = false

    var reported: [String] {
        [
            (notifications, Notifier.capability),
            (alarms, AlarmsCapability.capability),
            (screenTime, ScreenTimeCapability.capability),
            (focus, FocusCapability.capability),
            (nfc, NFCCapability.capability),
            (health, HealthCapability.capability),
        ].filter(\.0).map(\.1)
    }

    @MainActor
    static func current() async -> CapabilityStatus {
        let notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return CapabilityStatus(
            notifications: [.authorized, .provisional, .ephemeral].contains(notifications),
            alarms: AlarmManager.shared.authorizationState == .authorized,
            screenTime: ScreenTimeAuthorization.isApproved,
            focus: FocusLabels.file.read().setUp,
            nfc: NFCNDEFReaderSession.readingAvailable,
            health: HKHealthStore.isHealthDataAvailable() && !HealthSharing.file.read().shared.isEmpty
        )
    }
}
