import Foundation
import Observation

@MainActor
@Observable
final class ShareModel {
    enum State: Equatable {
        case loading
        case choosing
        case sending(ShareProgress)
        case sent(String)
        case failed(String)
    }

    private(set) var state: State = .loading
    private(set) var items = SharedItems()
    private(set) var options: [ShareOption] = []
    var selection: ShareOption.ID?
    /// A problem that keeps the chosen target from taking the items, such as a file too large.
    var problem: String? {
        guard let option = selected, let payload = ShareMatch.payload(for: option.target, items: items) else { return nil }
        return ShareMatch.problem(for: option.target, payload: payload)
    }

    @ObservationIgnored var finish: () -> Void = {}
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let folder = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString)", directoryHint: .isDirectory)
    @ObservationIgnored private let choices = ShareChoiceStore()
    @ObservationIgnored private let cache = ShareCatalogCache()

    var selected: ShareOption? {
        options.first { $0.id == selection }
    }

    func start(_ extensionItems: [NSExtensionItem]) async {
        guard let api = HostAPI.stored else {
            state = .failed("Open Hobwork and connect it to your Hobwork host first.")
            return
        }
        items = await ShareItemLoader.load(extensionItems, into: folder)
        guard !items.isEmpty else {
            state = .failed("There is nothing here Hobwork can take.")
            return
        }
        show(cache.hobs(for: api.host))
        do {
            let hobs = try await api.hobs()
            cache.save(hobs, for: api.host)
            show(hobs)
        } catch {
            if options.isEmpty { state = .failed("Couldn't reach your Hobwork host: \(error.localizedDescription)") }
            return
        }
        if options.isEmpty { state = .failed("None of your hobs take what you're sharing.") }
    }

    private func show(_ hobs: [HostHob]) {
        options = ShareMatch.options(hobs: hobs, items: items)
        guard !options.isEmpty else { return }
        if selected == nil { selection = choices.preferred(in: options)?.id }
        if state == .loading { state = .choosing }
    }

    func send() {
        guard let option = selected, let api = HostAPI.stored, let payload = ShareMatch.payload(for: option.target, items: items),
              problem == nil
        else { return }
        choices.remember(option)
        state = .sending(ShareProgress(stage: .uploading(file: 0), sent: 0, total: payload.files.reduce(0) { $0 + $1.size }))
        task = Task {
            do {
                let say = try await ShareSender(api: api).send(hob: option.hob, target: option.target.id, payload: payload) { progress in
                    Task { @MainActor in
                        if case .sending = self.state { self.state = .sending(progress) }
                    }
                }
                state = .sent(say ?? "Sent to \(option.target.title).")
            } catch is CancellationError {
                return
            } catch {
                state = .failed(error.localizedDescription)
            }
            cleanUp()
        }
    }

    func cancel() {
        task?.cancel()
        cleanUp()
    }

    func fileName(at index: Int, of option: ShareOption?) -> String? {
        guard let option, let payload = ShareMatch.payload(for: option.target, items: items), payload.files.indices.contains(index) else { return nil }
        return payload.files[index].name
    }

    private func cleanUp() {
        try? FileManager.default.removeItem(at: folder)
    }
}
