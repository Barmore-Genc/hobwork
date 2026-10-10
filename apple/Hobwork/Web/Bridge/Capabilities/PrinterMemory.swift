import Foundation

/// Printers each hob printed to, most recent first, so a hob can offer them again. On iOS
/// a printer's ID is its URL, on macOS its name.
@MainActor
final class PrinterMemory {
    struct Printer: Codable, Equatable, Sendable {
        var id: String
        var name: String
        var lastUsedAt: Date
    }

    static let limit = 10
    private let defaults: UserDefaults
    private let key = "bridgePrinters"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func printers(hob: String) -> [Printer] {
        all[hob] ?? []
    }

    func remember(_ printer: Printer, hob: String) {
        var printers = printers(hob: hob).filter { $0.id != printer.id }
        printers.insert(printer, at: 0)
        var all = all
        all[hob] = Array(printers.prefix(Self.limit))
        save(all)
    }

    func forget(id: String, hob: String) {
        var all = all
        all[hob] = printers(hob: hob).filter { $0.id != id }
        if all[hob]?.isEmpty == true { all[hob] = nil }
        save(all)
    }

    func forget(hob: String) {
        var all = all
        all[hob] = nil
        save(all)
    }

    private var all: [String: [Printer]] {
        guard let data = defaults.data(forKey: key) else { return [:] }
        return (try? JSONDecoder().decode([String: [Printer]].self, from: data)) ?? [:]
    }

    private func save(_ all: [String: [Printer]]) {
        defaults.set(try? JSONEncoder().encode(all), forKey: key)
    }
}

extension PrinterMemory.Printer {
    var json: JSONValue {
        .object(["id": .string(id), "name": .string(name), "lastUsedAt": .string(ISODate.format(lastUsedAt))])
    }
}
