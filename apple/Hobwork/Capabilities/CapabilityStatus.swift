#if os(iOS)
    import ActivityKit
    import AlarmKit
    import CoreNFC
    import HealthKit
    import HomeKit
#endif
import UserNotifications

/// Whether each capability is set up and allowed on this device. `hello` lists only those,
/// so the host refuses calls that could not work.
struct CapabilityStatus: Equatable, Sendable {
    var notifications = false
    #if os(iOS)
        var alarms = false
    #endif
    var focus = false
    #if os(iOS)
        var homekit = false
        var nfc = false
        var health = false
        var liveActivities = false
        /// The widget extension ships with the iOS app.
        var widgets = true
    #endif

    var reported: [String] {
        #if os(iOS)
            [
                (notifications, Notifier.capability),
                (alarms, AlarmsCapability.capability),
                (focus, FocusCapability.capability),
                (homekit, HomeKitCapability.capability),
                (nfc, NFCCapability.capability),
                (health, HealthCapability.capability),
                (liveActivities, LiveActivities.capability),
                (widgets, WidgetsCapability.capability),
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
                focus: FocusLabels.file.read().setUp,
                homekit: HomeKit.isAvailable,
                nfc: NFCNDEFReaderSession.readingAvailable,
                health: HKHealthStore.isHealthDataAvailable() && !HealthSharing.file.read().shared.isEmpty,
                liveActivities: ActivityAuthorizationInfo().areActivitiesEnabled
            )
        #else
            return CapabilityStatus(
                notifications: notifications,
                focus: FocusLabels.file.read().setUp
            )
        #endif
    }
}
