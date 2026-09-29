import Foundation

/// A JSON file that the app and its extensions read and change, each change under a
/// file lock, since they can run at the same time.
struct SharedFile<Value: Codable & Sendable>: Sendable {
    let url: URL
    let empty: Value

    init(url: URL, empty: Value) {
        self.url = url
        self.empty = empty
    }

    init(name: String, empty: Value) {
        self.init(url: AppGroup.containerURL.appending(path: name), empty: empty)
    }

    func read() -> Value {
        withLock { load() }
    }

    @discardableResult
    func update<Result>(_ change: (inout Value) throws -> Result) rethrows -> Result {
        try withLock {
            var value = load()
            let result = try change(&value)
            save(value)
            return result
        }
    }

    private func load() -> Value {
        guard let data = try? Data(contentsOf: url) else { return empty }
        return (try? JSONDecoder().decode(Value.self, from: data)) ?? empty
    }

    private func save(_ value: Value) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Extensions run while the phone is locked, after the first unlock.
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func withLock<Result>(_ body: () throws -> Result) rethrows -> Result {
        let lockPath = url.path + ".lock"
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(lockPath, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { return try body() }
        defer { close(descriptor) }
        flock(descriptor, LOCK_EX)
        defer { flock(descriptor, LOCK_UN) }
        return try body()
    }
}
