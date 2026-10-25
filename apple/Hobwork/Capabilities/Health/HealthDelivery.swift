import Foundation
import HealthKit

/// Background delivery: iOS wakes the app when new samples of a shared type arrive, and it
/// sends them as `samples` events, each sample once.
@MainActor
final class HealthDelivery {
    static let batchSize = 500

    private let store: HKHealthStore
    private let file: SharedFile<HealthSharing>
    private let send: (DeviceEvent) async -> Void
    private var queries: [HealthType: HKObserverQuery] = [:]

    init(store: HKHealthStore, file: SharedFile<HealthSharing> = HealthSharing.file, send: @escaping (DeviceEvent) async -> Void) {
        self.store = store
        self.file = file
        self.send = send
    }

    /// Observer queries have to be set up at every launch, including the background launches
    /// that background delivery causes.
    func start() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        guard file.read().isConnected else {
            for (type, query) in queries {
                store.stop(query)
                store.disableBackgroundDelivery(for: type.sampleType) { _, _ in }
            }
            queries.removeAll()
            return
        }
        for type in HealthType.allCases where queries[type] == nil {
            let query = HKObserverQuery(sampleType: type.sampleType, predicate: nil) { [weak self] _, completion, error in
                guard error == nil else {
                    completion()
                    return
                }
                let done = UncheckedCompletion(completion)
                Task { @MainActor in
                    await self?.deliver(type)
                    done.call()
                }
            }
            queries[type] = query
            store.execute(query)
            store.enableBackgroundDelivery(for: type.sampleType, frequency: .immediate) { _, _ in }
        }
    }

    /// Asks for read access to every type. The Health sheet is where the person picks what
    /// Hobwork may read; HealthKit does not tell apps which read types were allowed, so every
    /// type is connected and the ones not allowed return no samples. Records when Health was
    /// turned on, so background delivery starts from then and does not send the whole history.
    func connect(now: Date = Date()) async throws {
        try await store.requestAuthorization(toShare: [], read: Self.readTypes)
        file.update { $0.connectedAt = $0.connectedAt ?? now }
        start()
    }

    func disconnect() {
        file.update { $0 = HealthSharing() }
        start()
    }

    /// Whether connecting would show the Health sheet: before the first request, and after an
    /// update adds types.
    func needsRequest() async -> Bool {
        (try? await store.statusForAuthorizationRequest(toShare: [], read: Self.readTypes)) == .shouldRequest
    }

    private static var readTypes: Set<HKObjectType> { Set(HealthType.allCases.map(\.sampleType)) }

    private func deliver(_ type: HealthType) async {
        while true {
            let sharing = file.read()
            guard let since = sharing.connectedAt else { return }
            let anchor = sharing.anchors[type].flatMap {
                try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0)
            }
            let predicate = HKQuery.predicateForSamples(withStart: since, end: nil, options: [])
            let descriptor = HKAnchoredObjectQueryDescriptor(
                predicates: [.sample(type: type.sampleType, predicate: predicate)],
                anchor: anchor,
                limit: Self.batchSize
            )
            guard let result = try? await descriptor.result(for: store) else { return }
            let samples = result.addedSamples.compactMap { HealthSample($0, type: type) }
            if !samples.isEmpty, let event = try? Self.event(type: type, samples: samples) {
                await send(event)
            }
            let data = try? NSKeyedArchiver.archivedData(withRootObject: result.newAnchor, requiringSecureCoding: true)
            file.update { $0.anchors[type] = data }
            if result.addedSamples.count < Self.batchSize { return }
        }
    }

    nonisolated static func event(type: HealthType, samples: [HealthSample]) throws -> DeviceEvent {
        DeviceEvent(capability: HealthCapability.capability, name: "samples", data: .object([
            "type": .string(type.rawValue),
            "samples": try JSONValue(encoding: samples),
        ]))
    }
}

/// HealthKit's completion handler is not Sendable but has to be called after the async work.
private struct UncheckedCompletion: @unchecked Sendable {
    let call: () -> Void
    init(_ call: @escaping () -> Void) { self.call = call }
}
