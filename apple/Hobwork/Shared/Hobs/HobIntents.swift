import AppIntents
import Foundation

/// Runs an intent a hob declares, from Siri, Shortcuts, the Action Button or a control.
struct RunHobIntent: AppIntent {
    static let title: LocalizedStringResource = "Run Hob Action"
    static let description = IntentDescription("Runs an action of one of your hobs.")

    @Parameter(title: "Action")
    var action: HobIntentEntity

    // Hobs declare their own parameters, so the values are asked for one at a time
    // through these.
    @Parameter(title: "Text")
    var text: String?

    @Parameter(title: "Number")
    var number: Double?

    @Parameter(title: "Choice")
    var choice: Bool?

    static var parameterSummary: some ParameterSummary {
        Summary("Run \(\.$action)")
    }

    init() {}

    init(action: HobIntentEntity?) {
        if let action { self.action = action }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try HobDirectory.api()
        let hobs = try await HobDirectory.hobs()
        guard let definition = hobs.first(where: { $0.hob == action.hob })?.intents.first(where: { $0.id == action.intent }) else {
            throw HobIntentError.unknownAction
        }
        var values: [String: JSONValue] = [:]
        for parameter in definition.parameters {
            let dialog = IntentDialog("\(parameter.title)")
            switch parameter.type {
            case .text:
                let value = try await $text.requestValue(dialog)
                if !(parameter.optional && value.isEmpty) { values[parameter.id] = .string(value) }
            case .number:
                values[parameter.id] = try await .number($number.requestValue(dialog))
            case .boolean:
                values[parameter.id] = try await .bool($choice.requestValue(dialog))
            }
        }
        var outcome = HobIntentOutcome(open: definition.open)
        if definition.runs {
            do {
                outcome = try await api.runIntent(hob: action.hob, intent: action.intent, parameters: values)
            } catch let error as HobIntentError {
                throw error
            } catch {
                throw HobIntentError.unreachable(error.localizedDescription)
            }
        }
        let dialog = IntentDialog("\(outcome.say ?? "Done.")")
        if definition.opensApp || outcome.open != nil, let link = HobLink(hob: action.hob, path: outcome.open ?? definition.open) {
            return .result(opensIntent: OpenURLIntent(link.url), dialog: dialog)
        }
        return .result(dialog: dialog)
    }
}

/// Opens a page of a hob in Hobwork.
struct OpenHobPageIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Hob Page"
    static let description = IntentDescription("Opens a hob in Hobwork, at its start page or another page.")

    @Parameter(title: "Hob")
    var hob: HobEntity

    @Parameter(title: "Page", description: "A page of the hob, such as /spools. Leave empty for its start page.")
    var path: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$hob)") {
            \.$path
        }
    }

    init() {}

    init(hob: HobEntity?, path: String?) {
        if let hob { self.hob = hob }
        self.path = path
    }

    func perform() async throws -> some IntentResult & OpensIntent {
        guard let link = HobLink(hob: hob.id, path: path) else { throw HobIntentError.unknownAction }
        return .result(opensIntent: OpenURLIntent(link.url))
    }
}

/// Picks the hob a widget shows.
struct HobWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Hob"
    static let description = IntentDescription("Shows what a hob puts in its widget.")

    @Parameter(title: "Hob")
    var hob: HobEntity?

    init() {}

    init(hob: HobEntity?) {
        self.hob = hob
    }
}

/// Picks the action a "Hob Action" control runs.
struct HobActionControlIntent: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "Hob Action"

    @Parameter(title: "Action")
    var action: HobIntentEntity?

    init() {}
}

/// Picks the page a "Hob Page" control opens.
struct HobPageControlIntent: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "Hob Page"

    @Parameter(title: "Hob")
    var hob: HobEntity?

    @Parameter(title: "Page", description: "A page of the hob, such as /spools. Leave empty for its start page.")
    var path: String?

    init() {}
}
