import Foundation

/// The outcome of a command as stored, so a repeat gets the same answer.
struct CommandOutcome: Codable, Equatable, Sendable {
    var ok: Bool
    var value: JSONValue?
    var error: CallError?

    init(_ result: Result<JSONValue, CallError>) {
        switch result {
        // JSON null reads back as a missing value, so it is stored as one.
        case let .success(value): self.init(ok: true, value: value == .null ? nil : value, error: nil)
        case let .failure(error): self.init(ok: false, value: nil, error: error)
        }
    }

    init(ok: Bool, value: JSONValue?, error: CallError?) {
        self.ok = ok
        self.value = value
        self.error = error
    }

    var result: Result<JSONValue, CallError> {
        if ok { return .success(value ?? .null) }
        return .failure(error ?? CallError(code: "failed", message: "The command failed"))
    }
}

enum CommandClaim: Equatable, Sendable {
    /// The caller runs the command.
    case run
    /// It ran before.
    case done(CommandOutcome)
    /// Another process runs it right now.
    case running
}

/// Commands this device ran, shared by the app and its extensions so a command that
/// arrives by socket, push and hello runs once.
protocol CommandLog: Sendable {
    func claim(_ key: String, now: Date) -> CommandClaim
    func finish(_ key: String, outcome: CommandOutcome, now: Date)
    func outcome(_ key: String) -> CommandOutcome?
}

struct CommandLogEntry: Codable, Equatable, Sendable {
    var claimedAt: Date
    var outcome: CommandOutcome?
}

enum CommandLogPolicy {
    /// Commands expire 10 minutes after the host creates them; a day covers every repeat.
    static let retention: TimeInterval = 24 * 60 * 60
    /// A claim without an outcome after this long belongs to a process that was killed,
    /// for example a notification service extension that ran out of time.
    static let staleClaim: TimeInterval = 2 * 60

    static func claim(_ key: String, in entries: inout [String: CommandLogEntry], now: Date) -> CommandClaim {
        entries = entries.filter { now.timeIntervalSince($0.value.claimedAt) < retention }
        if let entry = entries[key] {
            if let outcome = entry.outcome { return .done(outcome) }
            if now.timeIntervalSince(entry.claimedAt) < staleClaim { return .running }
        }
        entries[key] = CommandLogEntry(claimedAt: now, outcome: nil)
        return .run
    }
}

struct FileCommandLog: CommandLog {
    let file: SharedFile<[String: CommandLogEntry]>

    init(file: SharedFile<[String: CommandLogEntry]> = SharedFile(name: "commands.json", empty: [:])) {
        self.file = file
    }

    func claim(_ key: String, now: Date) -> CommandClaim {
        file.update { CommandLogPolicy.claim(key, in: &$0, now: now) }
    }

    func finish(_ key: String, outcome: CommandOutcome, now: Date) {
        file.update { entries in
            entries[key] = CommandLogEntry(claimedAt: entries[key]?.claimedAt ?? now, outcome: outcome)
        }
    }

    func outcome(_ key: String) -> CommandOutcome? {
        file.read()[key]?.outcome
    }

    func contains(_ key: String) -> Bool {
        file.read()[key] != nil
    }
}

final class MemoryCommandLog: CommandLog, @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String: CommandLogEntry] = [:]

    func claim(_ key: String, now: Date) -> CommandClaim {
        lock.withLock { CommandLogPolicy.claim(key, in: &entries, now: now) }
    }

    func finish(_ key: String, outcome: CommandOutcome, now: Date) {
        lock.withLock {
            entries[key] = CommandLogEntry(claimedAt: entries[key]?.claimedAt ?? now, outcome: outcome)
        }
    }

    func outcome(_ key: String) -> CommandOutcome? {
        lock.withLock { entries[key]?.outcome }
    }
}
