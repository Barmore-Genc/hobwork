import Foundation
import Testing
@testable import Hobwork

struct ArgumentsTests {
    @Test func parsesTimesOfDay() {
        #expect(TimeOfDay("07:30") == TimeOfDay(hour: 7, minute: 30))
        #expect(TimeOfDay("23:59")?.minutesSinceMidnight == 23 * 60 + 59)
        for text in ["7:30", "24:00", "12:60", "12:3", "1230", "ab:cd", "12:30:00", ""] {
            #expect(TimeOfDay(text) == nil, "\(text)")
        }
    }

    @Test func parsesDatesWithOffsetsAndFractions() {
        #expect(ISODate.parse("2026-05-04T07:00:00Z") == Date(timeIntervalSince1970: 1_777_878_000))
        #expect(ISODate.parse("2026-05-04T09:00:00+02:00") == Date(timeIntervalSince1970: 1_777_878_000))
        #expect(ISODate.parse("2026-05-04T07:00:00.500Z") == Date(timeIntervalSince1970: 1_777_878_000.5))
        #expect(ISODate.parse("2026-05-04") == nil)
        #expect(ISODate.format(Date(timeIntervalSince1970: 1_777_878_000)) == "2026-05-04T07:00:00Z")
    }

    @Test func sortsDaysAndRejectsRepeats() throws {
        let args = try Arguments(json(#"{"days":["sun","mon","wed"]}"#), call: "test")
        #expect(try args.optionalDays("days") == [.mon, .wed, .sun])
        for bad in [#"{"days":["mon","mon"]}"#, #"{"days":[]}"#, #"{"days":["monday"]}"#, #"{"days":"mon"}"#] {
            #expect(throws: CallError.self) { try Arguments(json(bad), call: "test").optionalDays("days") }
        }
    }

    @Test func checksTypesAndRanges() throws {
        let args = try Arguments(json(#"{"n":5,"f":1.5,"s":"x","null":null}"#), call: "test")
        #expect(try args.int("n", in: 1 ... 10) == 5)
        #expect(throws: CallError.badRequest("n must be between 6 and 10")) { try args.int("n", in: 6 ... 10) }
        #expect(throws: CallError.badRequest("f must be a whole number")) { try args.int("f", in: 1 ... 10) }
        #expect(throws: CallError.badRequest("s must be a whole number")) { try args.int("s", in: 1 ... 10) }
        #expect(throws: CallError.badRequest("test needs missing")) { try args.string("missing") }
        #expect(try args.optionalString("null") == nil)
        #expect(throws: CallError.badRequest("test takes an object")) { try Arguments(json("[1]"), call: "test") }
        #expect(try Arguments(nil, call: "test").has("x") == false)
    }

    @Test func acceptsSlugs() {
        #expect(Slug.isValid("social"))
        #expect(Slug.isValid("school-night-2"))
        for bad in ["", "Social", "a.b", "-a", "a-", "a b", String(repeating: "a", count: 65)] {
            #expect(!Slug.isValid(bad), "\(bad)")
        }
    }
}

@MainActor
struct CommandRunnerTests {
    let log = MemoryCommandLog()
    let clock = ManualClock()
    let handler = RecordingHandler()

    func makeRunner(now: Date = isoDate("2026-05-04T07:00:00Z"), log: (any CommandLog)? = nil) -> CommandRunner {
        let clock = clock
        let runner = CommandRunner(log: log ?? self.log, now: { now }, sleep: { try await clock.sleep(for: $0) }, waitLimit: .seconds(2))
        runner.register(handler, for: "alarms")
        return runner
    }

    @Test func runsACommandOnceAndAnswersRepeatsFromTheLog() async {
        handler.reply = { _, _ in .object(["id": .string("a1")]) }
        let runner = makeRunner()
        let command = DeviceCommand(id: .string("c1"), capability: "alarms", method: "set")
        let first = await runner.run(command)
        let second = await makeRunner().run(command)
        #expect(first == CommandOutcome(.success(.object(["id": .string("a1")]))))
        #expect(second == first)
        #expect(handler.calls.count == 1)
    }

    @Test func remembersFailuresToo() async {
        handler.reply = { _, _ in throw CallError(code: "limit_reached", message: "Full") }
        let runner = makeRunner()
        let command = DeviceCommand(id: .string("c1"), capability: "alarms", method: "set")
        _ = await runner.run(command)
        #expect(await runner.run(command) == CommandOutcome(.failure(CallError(code: "limit_reached", message: "Full"))))
        #expect(handler.calls.count == 1)
    }

    @Test func answersExpiredCommandsWithoutRunningThem() async {
        let command = DeviceCommand(id: .string("c1"), capability: "alarms", method: "set", expiresAt: isoDate("2026-05-04T06:59:59Z"))
        let outcome = await makeRunner().run(command)
        #expect(outcome?.error?.code == "expired")
        #expect(handler.calls.isEmpty)
    }

    @Test func runsCommandsThatExpireLater() async {
        let command = DeviceCommand(id: .string("c1"), capability: "alarms", method: "set", expiresAt: isoDate("2026-05-04T07:10:00Z"))
        #expect(await makeRunner().run(command)?.ok == true)
    }

    @Test func refusesUnknownCapabilities() async {
        let outcome = await makeRunner().run(DeviceCommand(id: .number(3), capability: "nfc", method: "read"))
        #expect(outcome?.error?.code == "unsupported")
    }

    @Test func turnsOtherErrorsIntoFailed() async {
        handler.reply = { _, _ in throw URLError(.timedOut) }
        let outcome = await makeRunner().run(DeviceCommand(id: .string("c1"), capability: "alarms", method: "set"))
        #expect(outcome?.error?.code == "failed")
    }

    @Test func waitsForAnotherProcessThatRunsTheCommand() async throws {
        _ = log.claim("c1", now: isoDate("2026-05-04T07:00:00Z"))
        let runner = makeRunner()
        let task = Task { await runner.run(DeviceCommand(id: .string("c1"), capability: "alarms", method: "set")) }
        try await eventually("polling") { clock.pending == [.milliseconds(500)] }
        log.finish("c1", outcome: CommandOutcome(.success(.string("done"))), now: isoDate("2026-05-04T07:00:01Z"))
        clock.advance(by: .milliseconds(500))
        #expect(await task.value == CommandOutcome(.success(.string("done"))))
        #expect(handler.calls.isEmpty)
    }

    @Test func givesUpOnAnotherProcessWithoutAnswering() async throws {
        _ = log.claim("c1", now: isoDate("2026-05-04T07:00:00Z"))
        let runner = makeRunner()
        let task = Task { await runner.run(DeviceCommand(id: .string("c1"), capability: "alarms", method: "set")) }
        for _ in 0 ..< 4 {
            try await eventually("polling") { clock.pending == [.milliseconds(500)] }
            clock.advance(by: .milliseconds(500))
        }
        #expect(await task.value == nil)
    }

    @Test func keysCommandsByTheirID() {
        #expect(DeviceCommand(id: .string("abc"), capability: "x", method: "y").key == "abc")
        #expect(DeviceCommand(id: .number(7), capability: "x", method: "y").key == "7")
    }
}

struct CommandLogTests {
    let start = isoDate("2026-05-04T07:00:00Z")

    @Test func claimsOnceAndKeepsOutcomesForADay() {
        let log = FileCommandLog(file: temporaryFile([:]))
        #expect(log.claim("c1", now: start) == .run)
        #expect(log.claim("c1", now: start.addingTimeInterval(1)) == .running)
        let outcome = CommandOutcome(.success(.null))
        log.finish("c1", outcome: outcome, now: start.addingTimeInterval(2))
        #expect(log.claim("c1", now: start.addingTimeInterval(23 * 3600)) == .done(outcome))
        #expect(log.claim("c1", now: start.addingTimeInterval(24 * 3600)) == .run)
    }

    @Test func takesOverClaimsOfKilledProcesses() {
        let log = FileCommandLog(file: temporaryFile([:]))
        #expect(log.claim("c1", now: start) == .run)
        #expect(log.claim("c1", now: start.addingTimeInterval(119)) == .running)
        #expect(log.claim("c1", now: start.addingTimeInterval(120)) == .run)
    }

    @Test func dropsOldEntries() {
        let file = temporaryFile([String: CommandLogEntry]())
        let log = FileCommandLog(file: file)
        _ = log.claim("old", now: start)
        _ = log.claim("new", now: start.addingTimeInterval(25 * 3600))
        #expect(file.read().keys.sorted() == ["new"])
    }
}

struct CommandPushTests {
    @Test func readsCommandPushes() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "kitchen", "body": "Alarm change"], "mutable-content": 1],
            "hobwork": [
                "project": "kitchen",
                "command": [
                    "id": "5f0c", "capability": "alarms", "method": "cancel",
                    "args": ["id": "wake"], "expiresAt": "2026-05-04T07:10:00Z",
                ],
            ],
        ]
        #expect(CommandPush(userInfo: userInfo) == CommandPush(project: "kitchen", command: DeviceCommand(
            id: .string("5f0c"),
            capability: "alarms",
            method: "cancel",
            args: .object(["id": .string("wake")]),
            expiresAt: isoDate("2026-05-04T07:10:00Z")
        )))
    }

    @Test func readsForegroundCommands() {
        let userInfo: [AnyHashable: Any] = ["hobwork": [
            "project": "kitchen",
            "command": ["id": "9", "capability": "nfc", "method": "read", "foreground": true],
        ]]
        #expect(CommandPush(userInfo: userInfo)?.command.foreground == true)
    }

    @Test func ignoresNotificationPushes() {
        #expect(CommandPush(userInfo: ["hobwork": ["id": "n_1", "project": "filament"]]) == nil)
    }

    @Test func encodesResultsForTheResultsEndpoint() throws {
        let api = HostAPI(host: URL(string: "https://h.example.com")!, token: "hwd_abc")
        let ok = api.resultRequest(DeviceCallResult(id: .string("c1"), outcome: .success(.object(["id": .string("a")]))))
        #expect(ok.url?.absoluteString == "https://h.example.com/api/devices/results")
        #expect(ok.httpMethod == "POST")
        #expect(ok.value(forHTTPHeaderField: "Authorization") == "Bearer hwd_abc")
        #expect(try JSONDecoder().decode(JSONValue.self, from: ok.httpBody!) == json(#"{"id":"c1","ok":true,"value":{"id":"a"}}"#))

        let failed = api.resultRequest(DeviceCallResult(id: .string("c2"), outcome: .failure(CallError(code: "expired", message: "Late"))))
        #expect(try JSONDecoder().decode(JSONValue.self, from: failed.httpBody!)
            == json(#"{"id":"c2","ok":false,"error":{"code":"expired","message":"Late"}}"#))
    }
}

struct CommandSummaryTests {
    let now = isoDate("2026-05-04T12:00:00Z")

    func summary(_ capability: String, _ method: String, _ args: String, _ outcome: CommandOutcome = CommandOutcome(.success(.object([:])))) -> String {
        let command = DeviceCommand(id: .string("c"), capability: capability, method: method, args: json(args))
        return CommandSummary.text(for: command, outcome: outcome, now: now, calendar: utcCalendar, locale: Locale(identifier: "en_GB"))
    }

    @Test func describesAlarms() {
        #expect(summary("alarms", "set", #"{"title":"Wake up","time":"07:00","days":["mon","tue","wed","thu","fri"]}"#)
            == "Alarm \u{201C}Wake up\u{201D} set for 07:00 on weekdays")
        #expect(summary("alarms", "set", #"{"title":"Bins","at":"2026-05-04T19:00:00Z"}"#) == "Alarm \u{201C}Bins\u{201D} set for 19:00")
        #expect(summary("alarms", "set", #"{"at":"2026-05-05T09:30:00Z"}"#) == "Alarm set for Tue 09:30")
        #expect(summary("alarms", "timer", #"{"title":"Tea","seconds":270}"#) == "Timer set for 4 min 30 s")
        #expect(summary("alarms", "cancel", #"{"id":"x"}"#) == "Alarm cancelled")
    }

    @Test func describesFailures() {
        let failure = CommandOutcome(.failure(CallError(code: "not_found", message: "There is no alarm with this id")))
        #expect(summary("alarms", "cancel", #"{"id":"x"}"#, failure) == "Alarm change failed: There is no alarm with this id")
        let expired = CommandOutcome(.failure(CallError(code: "expired", message: "Late")))
        #expect(summary("alarms", "set", "{}", expired) == "A request from Hobwork arrived too late and was skipped.")
    }

    @Test func formatsDurations() {
        #expect(CommandSummary.duration(3600) == "1 h")
        #expect(CommandSummary.duration(3725) == "1 h 2 min 5 s")
        #expect(CommandSummary.duration(0) == "0 s")
    }
}

struct CapabilityStatusTests {
    @Test func reportsOnlyWhatIsAllowed() {
        #if os(iOS)
            #expect(CapabilityStatus().reported == ["widgets"])
            #expect(CapabilityStatus(notifications: true, nfc: true, widgets: false).reported == ["notifications", "nfc"])
            #expect(CapabilityStatus(notifications: true, alarms: true, focus: true, nfc: true, health: true, liveActivities: true).reported
                == ["notifications", "alarms", "focus", "nfc", "health", "liveActivities", "widgets"])
        #else
            #expect(CapabilityStatus().reported == [])
            #expect(CapabilityStatus(focus: true).reported == ["focus"])
            #expect(CapabilityStatus(notifications: true, focus: true).reported == ["notifications", "focus"])
        #endif
    }
}
