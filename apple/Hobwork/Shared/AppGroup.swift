import Foundation

/// State the app shares with its extensions.
enum AppGroup {
    static let identifier = "group.dev.bgenc.hobwork"

    /// Falls back to the process's own storage when the group is missing, as in a build
    /// signed without it, so the app keeps working without its extensions.
    static var containerURL: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
            ?? URL.applicationSupportDirectory
    }

    static var defaults: UserDefaults {
        UserDefaults(suiteName: identifier) ?? .standard
    }

    /// Whether this build was signed with Family Controls (`HOBWORK_FAMILY_CONTROLS`).
    static var hasFamilyControls: Bool {
        (Bundle.main.object(forInfoDictionaryKey: "HobworkFamilyControls") as? String) == "YES"
    }
}
