import SwiftUI
#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

#if os(macOS)
    @MainActor
    final class AppDelegate: NSObject, NSApplicationDelegate {
        /// Created at launch, so the notification delegate is in place before a click that
        /// launched the app is delivered.
        lazy var model = AppModel()

        func applicationDidFinishLaunching(_ notification: Notification) {
            _ = model
            // The socket drops while the Mac sleeps; waiting out the backoff would leave
            // the device offline for up to a minute after waking.
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.model.connection?.reconnect() }
            }
        }

        func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
            model.didRegisterForPush(token: deviceToken)
        }

        func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
            let info = UncheckedUserInfo(userInfo)
            Task { await model.didReceiveBackgroundPush(info.value) }
        }
    }
#else
    final class AppDelegate: NSObject, UIApplicationDelegate {
        /// Created at launch, so the notification delegate is in place before a tap that
        /// launched the app is delivered.
        @MainActor lazy var model = AppModel()

        func application(
            _ application: UIApplication,
            didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
        ) -> Bool {
            _ = model
            return true
        }

        func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
            model.didRegisterForPush(token: deviceToken)
        }

        /// Background pushes: relay renewals, and notifications a hob withdrew.
        func application(
            _ application: UIApplication,
            didReceiveRemoteNotification userInfo: [AnyHashable: Any],
            fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
        ) {
            let info = UncheckedUserInfo(userInfo)
            Notifier.complete(MainCompletion(completionHandler), with: .newData) {
                await self.model.didReceiveBackgroundPush(info.value)
            }
        }
    }
#endif

/// Push payloads are property lists, which the system hands over as non-Sendable dictionaries.
private struct UncheckedUserInfo: @unchecked Sendable {
    let value: [AnyHashable: Any]
    init(_ value: [AnyHashable: Any]) { self.value = value }
}

@main
struct HobworkApp: App {
    #if os(macOS)
        @NSApplicationDelegateAdaptor private var delegate: AppDelegate
    #else
        @UIApplicationDelegateAdaptor private var delegate: AppDelegate
    #endif
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        #if os(macOS)
            // One window: a second one would show the same web view.
            Window("Hobwork", id: "main") {
                RootView(model: delegate.model)
                    .frame(minWidth: 480, minHeight: 400)
            }
            .defaultSize(width: 1100, height: 760)
            .onChange(of: scenePhase) { _, phase in
                // The Mac keeps the app running with its window closed, so the socket stays
                // open to deliver notifications and commands.
                if phase == .active { delegate.model.sceneBecameActive() }
            }
            .commands {
                WebCommands(model: delegate.model)
            }

            Settings {
                SettingsView(model: delegate.model)
            }
        #else
            WindowGroup {
                RootView(model: delegate.model)
                    .onOpenURL { delegate.model.open($0) }
                    .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                        if let url = activity.webpageURL { delegate.model.open(url) }
                    }
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active: delegate.model.sceneBecameActive()
                case .background: delegate.model.sceneEnteredBackground()
                default: break
                }
            }
        #endif
    }
}

struct RootView: View {
    let model: AppModel

    #if os(macOS)
        @Environment(\.openWindow) private var openWindow
    #endif

    var body: some View {
        Group {
            if model.pairing != nil {
                MainView(model: model)
            } else {
                OnboardingView(model: model)
            }
        }
        #if os(macOS)
        .onAppear {
            model.showWindow = { [openWindow] in openWindow(id: "main") }
        }
        #endif
    }
}
