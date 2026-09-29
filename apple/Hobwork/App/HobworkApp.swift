import SwiftUI
import UIKit

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
}

@main
struct HobworkApp: App {
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(model: delegate.model)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: delegate.model.sceneBecameActive()
            case .background: delegate.model.sceneEnteredBackground()
            default: break
            }
        }
    }
}

struct RootView: View {
    let model: AppModel

    var body: some View {
        if model.pairing != nil {
            MainView(model: model)
        } else {
            OnboardingView(model: model)
        }
    }
}
