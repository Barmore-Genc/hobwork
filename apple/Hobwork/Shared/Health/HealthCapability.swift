import Foundation
import HealthKit

enum HealthReadError: Error, Equatable {
    /// Health data is encrypted while the phone is locked.
    case locked
    case notAuthorized
    case failed(String)
}

/// HealthKit, behind a protocol for tests.
@MainActor
protocol HealthReading: AnyObject {
    func samples(of type: HealthType, from: Date, to: Date, limit: Int) async throws(HealthReadError) -> [HealthSample]
}

/// The `health` capability.
@MainActor
final class HealthCapability: CapabilityHandler {
    nonisolated static let capability = "health"
    static let maxSamples = 1000

    private let reader: any HealthReading
    private let sharing: () -> Set<HealthType>

    init(reader: any HealthReading, sharing: @escaping () -> Set<HealthType> = { HealthSharing.file.read().types }) {
        self.reader = reader
        self.sharing = sharing
    }

    func handle(method: String, args: JSONValue?) async throws -> JSONValue {
        guard method == "query" else { throw CallError.unsupported(Self.capability, method) }
        let query = try Self.query(from: Arguments(args, call: "health.query"))
        guard sharing().contains(query.type) else {
            throw CallError(code: "not_shared", message: "Health is not connected to Hobwork on this device. Connect it in the Hobwork app's settings.")
        }
        let samples: [HealthSample]
        do {
            samples = try await reader.samples(of: query.type, from: query.from, to: query.to, limit: query.limit)
        } catch {
            switch error {
            case .locked: throw CallError(code: "locked", message: "Health data can't be read while this device is locked")
            case .notAuthorized: throw CallError.notAuthorized("Hobwork may not read \(query.type.title) on this device")
            case let .failed(message): throw CallError(code: "failed", message: message)
            }
        }
        return try JSONValue(encoding: samples)
    }

    struct Query: Equatable {
        var type: HealthType
        var from: Date
        var to: Date
        var limit: Int
    }

    static func query(from args: Arguments) throws(CallError) -> Query {
        let name = try args.string("type")
        guard let type = HealthType(rawValue: name) else {
            throw .badRequest("type must be one of \(HealthType.allCases.map(\.rawValue).joined(separator: ", "))")
        }
        let from = try args.date("from")
        let to = try args.date("to")
        guard from < to else { throw .badRequest("from must be before to") }
        let limit = try args.optionalInt("limit", in: 1 ... maxSamples) ?? maxSamples
        return Query(type: type, from: from, to: to, limit: limit)
    }
}

@MainActor
final class HealthKitReader: HealthReading {
    let store: HKHealthStore

    init(store: HKHealthStore = HKHealthStore()) {
        self.store = store
    }

    static var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    func samples(of type: HealthType, from: Date, to: Date, limit: Int) async throws(HealthReadError) -> [HealthSample] {
        let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.sample(type: type.sampleType, predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate)],
            limit: limit
        )
        do {
            return try await descriptor.result(for: store).compactMap { HealthSample($0, type: type) }
        } catch {
            throw Self.readError(error)
        }
    }

    nonisolated static func readError(_ error: Error) -> HealthReadError {
        guard let error = error as? HKError else { return .failed(error.localizedDescription) }
        switch error.code {
        case .errorDatabaseInaccessible: return .locked
        case .errorAuthorizationDenied, .errorAuthorizationNotDetermined: return .notAuthorized
        default: return .failed(error.localizedDescription)
        }
    }
}
