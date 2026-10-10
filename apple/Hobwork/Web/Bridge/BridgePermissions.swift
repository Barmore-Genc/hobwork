import Foundation

/// The person's answers to `BridgePermission` questions, per hob.
@MainActor
protocol BridgePermissionStore: AnyObject {
    func decision(hob: String, key: String) -> Bool?
    func set(_ allowed: Bool?, hob: String, key: String)
    func forget(hob: String)
    /// Hob key to permission key to answer.
    var all: [String: [String: Bool]] { get }
}

@MainActor
final class DefaultsPermissionStore: BridgePermissionStore {
    private let defaults: UserDefaults
    private let key = "bridgePermissions"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var all: [String: [String: Bool]] {
        defaults.dictionary(forKey: key) as? [String: [String: Bool]] ?? [:]
    }

    func decision(hob: String, key: String) -> Bool? {
        all[hob]?[key]
    }

    func set(_ allowed: Bool?, hob: String, key: String) {
        var all = all
        var answers = all[hob] ?? [:]
        answers[key] = allowed
        all[hob] = answers.isEmpty ? nil : answers
        defaults.set(all, forKey: self.key)
    }

    func forget(hob: String) {
        var all = all
        all[hob] = nil
        defaults.set(all, forKey: key)
    }
}

/// Shows the native question and returns whether the person allowed it, or nil when it
/// could not be shown.
@MainActor
protocol BridgePrompter {
    func ask(title: String, message: String, presenter: any BridgePresenter) async -> Bool?
}

/// Asks each question once per hob, and once at a time when a page asks twice.
@MainActor
final class BridgeGatekeeper {
    let store: any BridgePermissionStore
    private let prompter: any BridgePrompter
    private var pending: [String: Task<Bool?, Never>] = [:]

    init(store: any BridgePermissionStore, prompter: any BridgePrompter) {
        self.store = store
        self.prompter = prompter
    }

    func allows(_ permission: BridgePermission, origin: HobOrigin, presenter: any BridgePresenter) async -> Bool {
        let hob = origin.permissionKey
        if let decision = store.decision(hob: hob, key: permission.key) { return decision }
        let pendingKey = "\(hob)\n\(permission.key)"
        if let task = pending[pendingKey] { return await task.value ?? false }
        let task = Task {
            await prompter.ask(title: permission.title(origin.hob), message: permission.message, presenter: presenter)
        }
        pending[pendingKey] = task
        let allowed = await task.value
        pending[pendingKey] = nil
        guard let allowed else { return false }
        store.set(allowed, hob: hob, key: permission.key)
        return allowed
    }
}
