#if os(iOS)
    import AlarmKit
    import CoreNFC
    import FamilyControls
    import HealthKit
#endif
import UserNotifications

/// Whether each capability is set up and allowed on this device. `hello` lists only those,
/// so the host refuses calls that could not work.
struct CapabilityStatus: Equatable, Sendable {
    var notifications = false
    #if os(iOS)
        var alarms = false
        var screenTime = false
    #endif
    var focus = false
    #if os(iOS)
        var nfc = false
        var health = false
    #endif

    var reported: [String] {
        #if os(iOS)
            [
                (notifications, Notifier.capability),
                (alarms, AlarmsCapability.capability),
                (screenTime, ScreenTimeCapability.capability),
                (focus, FocusCapability.capability),
                (nfc, NFCCapability.capability),
                (health, HealthCapability.capability),
            ].filter(\.0).map(\.1)
        #else
            [
                (notifications, Notifier.capability),
                (focus, FocusCapability.capability),
            ].filter(\.0).map(\.1)
        #endif
    }

    @MainActor
    static func current() async -> CapabilityStatus {
        let notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus.allowsNotifications
        #if os(iOS)
            return CapabilityStatus(
                notifications: notifications,
                alarms: AlarmManager.shared.authorizationState == .authorized,
                screenTime: ScreenTimeAuthorization.isApproved,
                focus: FocusLabels.file.read().setUp,
                nfc: NFCNDEFReaderSession.readingAvailable,
                health: HKHealthStore.isHealthDataAvailable() && !HealthSharing.file.read().shared.isEmpty
            )
        #else
            return CapabilityStatus(
                notifications: notifications,
                focus: FocusLabels.file.read().setUp
            )
        #endif
    }
}
