import AppIntents
import SwiftUI
import WidgetKit

/// A Control Center, Lock Screen or Action Button control that runs a hob's action.
struct HobActionControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(kind: "dev.bgenc.hobwork.HobAction", intent: HobActionControlIntent.self) { configuration in
            ControlWidgetButton(action: RunHobIntent(action: configuration.action)) {
                Label(configuration.action?.title ?? "Hob Action", systemImage: "bolt.fill")
            }
        }
        .displayName("Hob Action")
        .description("Runs an action of one of your hobs.")
        .promptsForUserConfiguration()
    }
}

/// A control that opens a page of a hob.
struct HobPageControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(kind: "dev.bgenc.hobwork.HobPage", intent: HobPageControlIntent.self) { configuration in
            ControlWidgetButton(action: OpenHobPageIntent(hob: configuration.hob, path: configuration.path)) {
                Label(configuration.hob?.id ?? "Hob Page", systemImage: "rectangle.portrait.on.rectangle.portrait")
            }
        }
        .displayName("Hob Page")
        .description("Opens a hob in Hobwork.")
        .promptsForUserConfiguration()
    }
}
