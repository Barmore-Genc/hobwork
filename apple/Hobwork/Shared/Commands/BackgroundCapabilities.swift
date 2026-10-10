import Foundation

/// Capabilities that run without the app on screen, in the app and in the notification
/// service extension.
@MainActor
enum BackgroundCapabilities {
    #if os(iOS)
        static func register(on runner: CommandRunner, alarms: AlarmKitScheduler = AlarmKitScheduler(), health: HealthKitReader = HealthKitReader()) {
            runner.register(AlarmsCapability(scheduler: alarms), for: AlarmsCapability.capability)
            runner.register(FocusCapability(), for: FocusCapability.capability)
            runner.register(HealthCapability(reader: health), for: HealthCapability.capability)
        }
    #else
        static func register(on runner: CommandRunner) {
            runner.register(FocusCapability(), for: FocusCapability.capability)
        }
    #endif
}
