import AlarmKit
import Foundation
import Testing
@testable import Hobwork

@MainActor
struct AlarmsTests {
    let now = isoDate("2026-05-04T07:00:00Z")
    let scheduler = FakeAlarmScheduler()
    let records = temporaryFile([AlarmRecord]())
    let id = "6a1d3b3e-8a55-4f4c-9d6f-0a2f5b0c7e11"

    func makeCapability() -> AlarmsCapability {
        let now = now
        return AlarmsCapability(scheduler: scheduler, records: records, now: { now })
    }

    func alarm(_ args: String) throws -> AlarmRecord {
        try AlarmsCapability.alarm(from: Arguments(json(args), call: "alarms.set"), now: now)
    }

    @Test func parsesOneOffAlarms() throws {
        let record = try alarm(#"{"title":"Bins","at":"2026-05-04T19:00:00Z","id":"\#(id)"}"#)
        #expect(record == AlarmRecord(id: id, title: "Bins", at: isoDate("2026-05-04T19:00:00Z")))
    }

    @Test func parsesRepeatingAlarms() throws {
        let record = try alarm(#"{"title":"Wake up","time":"06:45","days":["fri","mon"]}"#)
        #expect(record.time == TimeOfDay(hour: 6, minute: 45))
        #expect(record.days == [.mon, .fri])
        #expect(UUID(uuidString: record.id) != nil)
        #expect(record.id == record.id.lowercased())
    }

    @Test func needsExactlyOneOfAtOrTime() {
        for args in [
            #"{"title":"x"}"#,
            #"{"title":"x","at":"2026-05-04T19:00:00Z","time":"07:00"}"#,
            #"{"title":"x","at":"2026-05-04T19:00:00Z","days":["mon"]}"#,
            #"{"title":"x","at":"2026-05-04T06:00:00Z"}"#,
            #"{"title":"","time":"07:00"}"#,
            #"{"title":"x","time":"7am"}"#,
            #"{"title":"x","time":"07:00","id":"not-a-uuid"}"#,
        ] {
            #expect(throws: CallError.self, "\(args)") { try alarm(args) }
        }
    }

    @Test func parsesTimers() throws {
        let record = try AlarmsCapability.timer(from: Arguments(json(#"{"title":"Tea","seconds":240}"#), call: "alarms.timer"))
        #expect(record.seconds == 240)
        #expect(throws: CallError.self) { try AlarmsCapability.timer(from: Arguments(json(#"{"title":"Tea","seconds":0}"#), call: "t")) }
        #expect(throws: CallError.self) { try AlarmsCapability.timer(from: Arguments(json(#"{"title":"Tea","seconds":90000}"#), call: "t")) }
    }

    @Test func mapsSchedulesToAlarmKit() {
        let fixed = AlarmRecord(id: id, title: "x", at: now)
        #expect(AlarmKitScheduler.schedule(for: fixed) == .fixed(now))

        let daily = AlarmRecord(id: id, title: "x", time: TimeOfDay(hour: 6, minute: 45))
        #expect(AlarmKitScheduler.schedule(for: daily) == .relative(.init(time: .init(hour: 6, minute: 45), repeats: .never)))

        let weekly = AlarmRecord(id: id, title: "x", time: TimeOfDay(hour: 7, minute: 0), days: [.mon, .sun])
        #expect(AlarmKitScheduler.schedule(for: weekly) == .relative(.init(time: .init(hour: 7, minute: 0), repeats: .weekly([.monday, .sunday]))))

        #expect(AlarmKitScheduler.schedule(for: AlarmRecord(id: id, title: "x", seconds: 60)) == nil)
    }

    @Test func setsAndReplacesAlarms() async throws {
        let capability = makeCapability()
        let first = try await capability.handle(method: "set", args: json(#"{"title":"Wake","time":"07:00","id":"\#(id)"}"#))
        #expect(first == .object(["id": .string(id)]))
        _ = try await capability.handle(method: "set", args: json(#"{"title":"Wake later","time":"07:30","id":"\#(id)"}"#))
        #expect(scheduler.cancelled == [UUID(uuidString: id)!, UUID(uuidString: id)!])
        #expect(records.read().map(\.title) == ["Wake later"])
    }

    @Test func listsAlarmsWithTheirTitles() async throws {
        let capability = makeCapability()
        _ = try await capability.handle(method: "set", args: json(#"{"title":"Wake","time":"07:00","days":["mon"],"id":"\#(id)"}"#))
        let list = try await capability.handle(method: "list", args: nil)
        #expect(list == json(#"[{"id":"\#(id)","title":"Wake","state":"scheduled","time":"07:00","days":["mon"]}]"#))
    }

    @Test func forgetsAlarmsThatAreGone() async throws {
        let capability = makeCapability()
        _ = try await capability.handle(method: "timer", args: json(#"{"title":"Tea","seconds":60,"id":"\#(id)"}"#))
        scheduler.states = [:]
        #expect(try await capability.handle(method: "list", args: nil) == .array([]))
        #expect(records.read().isEmpty)
    }

    @Test func cancelsUnknownAlarmsQuietly() async throws {
        let capability = makeCapability()
        #expect(try await capability.handle(method: "cancel", args: json(#"{"id":"\#(id)"}"#)) == .object([:]))
        #expect(try await capability.handle(method: "cancel", args: json(#"{"id":"whatever"}"#)) == .object([:]))
    }

    @Test func reportsTheLimit() async {
        scheduler.failure = .limitReached
        await #expect(throws: CallError(code: "limit_reached", message: "This device has as many alarms from Hobwork as iOS allows")) {
            try await makeCapability().handle(method: "timer", args: json(#"{"title":"Tea","seconds":60}"#))
        }
    }

    @Test func needsPermission() async {
        scheduler.isAuthorized = false
        await #expect {
            try await makeCapability().handle(method: "set", args: json(#"{"title":"Wake","time":"07:00"}"#))
        } throws: { ($0 as? CallError)?.code == "not_authorized" }
        #expect(scheduler.scheduled.isEmpty)
    }
}
