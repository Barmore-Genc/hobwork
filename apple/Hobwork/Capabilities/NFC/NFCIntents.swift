import AppIntents
import Foundation

/// Hands a tag's link to Hobwork from Shortcuts, such as a "When I tap an NFC tag" automation.
/// iOS opens links from tags in Safari unless they are universal links of Hobwork's host, so
/// this is how tags with other links reach projects without opening the app.
struct SendTagIntent: AppIntent {
    static let title: LocalizedStringResource = "Send Tag to Hobwork"
    static let description = IntentDescription(
        "Sends a link to your Hobwork hobs as if you scanned a tag with it. Use it in a Shortcuts automation for an NFC tag."
    )
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Link", description: "The tag's link, such as https://example.com/spools/3.")
    var url: URL

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$url) to Hobwork")
    }

    func perform() async throws -> some IntentResult {
        guard let pairing = StoredPairing.load() else { throw TagIntentError.notPaired }
        let event = NFCTagLink.event(url: url, host: pairing.host)
        do {
            try await HostAPI(host: pairing.host, token: pairing.credentials.token).send(event)
        } catch {
            throw TagIntentError.unreachable(error.localizedDescription)
        }
        return .result()
    }
}

/// Opens Hobwork and scans a tag, for the Action Button, Control Center or a shortcut.
struct ScanTagIntent: AppIntent {
    static let title: LocalizedStringResource = "Scan NFC Tag"
    static let description = IntentDescription("Opens Hobwork and scans an NFC tag. Its link goes to your Hobwork hobs.")
    static let supportedModes: IntentModes = .foreground(.immediate)

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let model = EventSender.model, model.pairing != nil else { throw TagIntentError.notPaired }
        // Returns before the scan, which waits for the person to hold the phone to a tag.
        Task { await model.scanTagWhenActive() }
        return .result()
    }
}

enum TagIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notPaired
    case unreachable(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notPaired: "Open Hobwork and connect it to your Hobwork host first."
        case let .unreachable(reason): "Couldn't reach your Hobwork host: \(reason)"
        }
    }
}

struct HobworkShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ScanTagIntent(),
            phrases: ["Scan a tag with \(.applicationName)", "Scan an NFC tag with \(.applicationName)"],
            shortTitle: "Scan NFC Tag",
            systemImageName: "wave.3.right"
        )
    }
}
