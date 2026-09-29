import Foundation

typealias Sleep = @Sendable (Duration) async throws -> Void

/// Runs commands through the capability handlers, once per command ID across the app and
/// its extensions.
@MainActor
final class CommandRunner {
    private let log: any CommandLog
    private let now: @Sendable () -> Date
    private let sleep: Sleep
    /// How long to wait for another process that runs the same command.
    private let waitLimit: Duration
    private var handlers: [String: any CapabilityHandler] = [:]
    private var inFlight: [String: Task<CommandOutcome, Never>] = [:]

    init(
        log: any CommandLog = MemoryCommandLog(),
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping Sleep = { try await Task.sleep(for: $0) },
        waitLimit: Duration = .seconds(20)
    ) {
        self.log = log
        self.now = now
        self.sleep = sleep
        self.waitLimit = waitLimit
    }

    func register(_ handler: any CapabilityHandler, for capability: String) {
        handlers[capability] = handler
    }

    /// The outcome to answer with, or nil when another process runs the command and has
    /// not finished in time; it answers the host itself.
    func run(_ command: DeviceCommand) async -> CommandOutcome? {
        let key = command.key
        if let task = inFlight[key] { return await task.value }
        switch log.claim(key, now: now()) {
        case let .done(outcome):
            return outcome
        case .running:
            return await waitForOtherProcess(key)
        case .run:
            let task = Task { await self.execute(command) }
            inFlight[key] = task
            let outcome = await task.value
            inFlight[key] = nil
            log.finish(key, outcome: outcome, now: now())
            return outcome
        }
    }

    private func execute(_ command: DeviceCommand) async -> CommandOutcome {
        if let expiresAt = command.expiresAt, expiresAt <= now() {
            return CommandOutcome(.failure(CallError(code: "expired", message: "The command expired before it reached this device")))
        }
        guard let handler = handlers[command.capability] else {
            return CommandOutcome(.failure(CallError(code: "unsupported", message: "This device does not support \(command.capability)")))
        }
        do {
            return try CommandOutcome(.success(await handler.handle(method: command.method, args: command.args)))
        } catch let error as CallError {
            return CommandOutcome(.failure(error))
        } catch {
            return CommandOutcome(.failure(CallError(code: "failed", message: error.localizedDescription)))
        }
    }

    private func waitForOtherProcess(_ key: String) async -> CommandOutcome? {
        let interval = Duration.milliseconds(500)
        var waited = Duration.zero
        while waited < waitLimit {
            do { try await sleep(interval) } catch { return nil }
            waited += interval
            if let outcome = log.outcome(key) { return outcome }
        }
        return nil
    }
}
