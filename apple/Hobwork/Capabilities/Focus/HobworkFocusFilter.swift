import AppIntents

/// The Focus filter people add to a Focus in Settings. iOS runs it with the label when that
/// Focus turns on and with no label when it turns off.
struct HobworkFocusFilter: SetFocusFilterIntent {
    static let title: LocalizedStringResource = "Tell Hobwork"
    static let description: IntentDescription? = IntentDescription(
        "Lets your Hobwork hobs know when this Focus turns on or off. The label tells them which Focus it is."
    )

    @Parameter(title: "Label", description: "A short name hobs use for this Focus, such as work.")
    var label: String?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: label.map { "Hobwork: \($0)" } ?? "Hobwork")
    }

    func perform() async throws -> some IntentResult {
        let events = FocusLabels.file.update { $0.apply(label: label) }
        for event in events {
            await EventSender.send(event)
        }
        return .result()
    }
}
