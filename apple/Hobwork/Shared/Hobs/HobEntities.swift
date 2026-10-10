import AppIntents
import Foundation

/// The hobs and their intents on the paired host, for the entity queries.
enum HobDirectory {
    static func api() throws(HobIntentError) -> HostAPI {
        guard let api = HostAPI.stored else { throw .notPaired }
        return api
    }

    static func hobs() async throws -> [HostHob] {
        do {
            return try await api().hobs()
        } catch let error as HobIntentError {
            throw error
        } catch {
            throw HobIntentError.unreachable(error.localizedDescription)
        }
    }
}

struct HobEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Hob"
    static let defaultQuery = HobEntityQuery()

    /// The hob's name.
    var id: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(id)")
    }
}

struct HobEntityQuery: EntityQuery {
    /// Names are IDs, so a configured widget or control keeps working while the host is out of reach.
    func entities(for identifiers: [String]) async throws -> [HobEntity] {
        identifiers.map(HobEntity.init(id:))
    }

    func suggestedEntities() async throws -> [HobEntity] {
        try await HobDirectory.hobs().map { HobEntity(id: $0.hob) }
    }
}

/// One of a hob's intents, `<hob>/<intent>`.
struct HobIntentEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Hob Action"
    static let defaultQuery = HobIntentEntityQuery()

    var id: String
    var title: String

    init(hob: String, intent: HostHobIntent) {
        id = "\(hob)/\(intent.id)"
        title = intent.title
    }

    init(id: String, title: String) {
        self.id = id
        self.title = title
    }

    var hob: String { String(id.split(separator: "/", maxSplits: 1).first ?? "") }
    var intent: String { String(id.split(separator: "/", maxSplits: 1).dropFirst().first ?? "") }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(hob)")
    }
}

struct HobIntentEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [HobIntentEntity] {
        let all = (try? await suggestedEntities()) ?? []
        return identifiers.map { id in all.first { $0.id == id } ?? HobIntentEntity(id: id, title: String(id.split(separator: "/").last ?? "")) }
    }

    func suggestedEntities() async throws -> [HobIntentEntity] {
        try await HobDirectory.hobs().flatMap { hob in hob.intents.map { HobIntentEntity(hob: hob.hob, intent: $0) } }
    }
}
