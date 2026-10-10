import Foundation
import Testing
@testable import Hobwork

@MainActor
final class Delivered {
    var scripts: [String] = []

    func contains(_ text: String) -> Bool {
        scripts.contains { $0.contains(text) }
    }
}

@MainActor
struct NFCBridgeTests {
    let policy = LinkPolicy(host: URL(string: "https://hobwork.example.com")!)
    let store = MemoryPermissionStore()
    let prompter = FakePrompter(answer: true)
    let presenter = FakePresenter()
    let session = FakeNFCSession()
    let delivered = Delivered()
    let frame = Frame()

    var filament: HobOrigin { policy.hobOrigin(scheme: "https", host: "filament.apps.hobwork.example.com", port: nil)! }

    func router(handoff: @escaping NFCBridge.Handoff = { _, _, _, _ in .null }) -> BridgeRouter {
        let delivered = delivered
        let router = BridgeRouter(gatekeeper: BridgeGatekeeper(store: store, prompter: prompter)) { _, script in
            delivered.scripts.append(script)
            return true
        }
        router.register(NFCBridge(session: session, host: { URL(string: "https://hobwork.example.com") }, handoff: handoff))
        return router
    }

    func call(_ router: BridgeRouter, _ method: String, _ args: String = "null") async -> JSONValue {
        let body = JSONValue.object(["capability": .string("nfc"), "method": .string(method), "args": json(args), "page": .string("p1")])
        return await router.handle(body: body, origin: filament, frame: frame, presenter: presenter)
    }

    func subscribe(_ router: BridgeRouter, _ event: String) async {
        let body = JSONValue.object([
            "capability": .string("bridge"), "method": .string("subscribe"),
            "args": .object(["event": .string(event)]), "page": .string("p1"),
        ])
        _ = await router.handle(body: body, origin: filament, frame: frame, presenter: presenter)
    }

    @Test func listsSessionsOnlyWhereThereIsNFC() {
        #expect(router().manifest["nfc"] == ["read", "startSession", "stopSession", "updateSession", "write"])
        session.isAvailable = false
        #expect(router().manifest["nfc"] == ["read", "write"])
    }

    @Test func readsWithTheSheetTextAndHardwareID() async {
        session.records = [NFCRecord(type: .url, value: "https://hobwork.example.com/nfc/abc")]
        let reply = await call(router(), "read", #"{"alertMessage":"Hold it near bin 4"}"#)
        #expect(reply["value"] == json(#"{"records":[{"type":"url","value":"https://hobwork.example.com/nfc/abc"}],"tag":"abc","uid":"04a2245a8b6380"}"#))
        #expect(session.sheets == [NFCSheet(alertMessage: "Hold it near bin 4")])
        #expect(prompter.questions.isEmpty)
    }

    @Test func writingAsksOnceAndReportsTheReason() async {
        let router = router()
        let reply = await call(router, "write", #"{"url":"https://example.com/spool/78"}"#)
        #expect(reply["value"] == json(#"{"url":"https://example.com/spool/78","uid":"04a2245a8b6380","verified":true}"#))
        #expect(prompter.questions == ["Let “filament” write NFC tags?"])

        session.failure = .tooSmall
        let failed = await call(router, "write", #"{"url":"https://example.com/spool/78"}"#)
        #expect(failed["error"] == json(#"{"code":"failed","message":"This tag is too small for the message","reason":"too_small"}"#))
        #expect(prompter.questions.count == 1)

        session.failure = nil
        #expect(await call(router, "write", #"{}"#)["error"]?["code"] == .string("failed"))
        #expect(await call(router, "write", #"{"url":"javascript:alert(1)"}"#)["error"]?["code"] == .string("failed"))
    }

    @Test func handsWritesToAnotherDevice() async {
        session.isAvailable = false
        var sent: [(String, String, String, JSONValue)] = []
        let router = router { hob, device, method, args in
            sent.append((hob, device, method, args))
            return json(#"{"ok":true,"device":"kaan-iphone","value":{"url":"https://example.com/bin/4","uid":"04aa","verified":true}}"#)
        }
        let reply = await call(router, "write", #"{"url":"https://example.com/bin/4","device":"lastActive","alertMessage":"Bin 4"}"#)
        #expect(reply["value"] == json(#"{"url":"https://example.com/bin/4","uid":"04aa","verified":true,"device":"kaan-iphone"}"#))
        #expect(sent.count == 1)
        #expect(sent.first?.0 == "filament")
        #expect(sent.first?.1 == "lastActive")
        #expect(sent.first?.3 == json(#"{"url":"https://example.com/bin/4","alertMessage":"Bin 4"}"#))
        #expect(await call(router, "read")["error"]?["code"] == .string("unavailable"))
    }

    @Test func mapsHandOffFailures() {
        let cases: [(String, BridgeError.Code, String?)] = [
            (#"{"ok":false,"error":{"code":"cancelled","message":"Closed"}}"#, .cancelled, nil),
            (#"{"ok":false,"error":{"code":"unreachable","message":"No phone"}}"#, .unavailable, "unreachable"),
            (#"{"ok":false,"error":{"code":"timeout","message":"Slow"}}"#, .failed, "timeout"),
            (#"{"ok":false,"error":{"code":"too_small","message":"Small"}}"#, .failed, "too_small"),
        ]
        for (reply, code, reason) in cases {
            #expect(throws: BridgeError.self) { try NFCBridge.handoffResult(json(reply)) }
            do {
                _ = try NFCBridge.handoffResult(json(reply))
            } catch {
                #expect(error.code == code)
                #expect(error.reason == reason)
            }
        }
    }

    @Test func streamsTagsUntilTheSessionEnds() async throws {
        let router = router()
        await subscribe(router, "nfc.tag")
        await subscribe(router, "nfc.ended")
        let started = await call(router, "startSession", #"{"alertMessage":"Tap a bin","keepOpen":true}"#)
        let id = try #require(started["value"]?["session"]?.stringValue)
        #expect(session.sheets == [NFCSheet(alertMessage: "Tap a bin")])
        #expect(await call(router, "startSession")["error"]?["reason"] == .string("busy"))

        session.tag(NFCTagRead(records: [NFCRecord(type: .url, value: "https://example.com/bin/4")], uid: "04bb"))
        try await Task.sleep(for: .milliseconds(50))
        #expect(delivered.contains("\"nfc.tag\""))
        #expect(delivered.contains("04bb"))
        #expect(delivered.contains(id))

        _ = await call(router, "updateSession", #"{"session":"\#(id)","alertMessage":"Now the spool"}"#)
        #expect(session.alerts == ["Now the spool"])
        #expect(await call(router, "stopSession", #"{"session":"other"}"#)["error"]?["code"] == .string("failed"))
        _ = await call(router, "stopSession", #"{"session":"\#(id)","successMessage":"Done"}"#)
        #expect(session.stopped == ["Done"])
        try await Task.sleep(for: .milliseconds(50))
        #expect(delivered.contains("\"nfc.ended\""))
        #expect(delivered.contains("\"stopped\""))
        #expect(await call(router, "updateSession", #"{"session":"\#(id)","alertMessage":"x"}"#)["error"]?["code"] == .string("failed"))
    }

    @Test func reportsWhyIOSEndedTheSession() async throws {
        let router = router()
        await subscribe(router, "nfc.ended")
        _ = await call(router, "startSession", #"{"keepOpen":true}"#)
        session.end(.timeout)
        try await Task.sleep(for: .milliseconds(50))
        #expect(delivered.contains("\"timeout\""))
        // A new session can start right away.
        #expect(await call(router, "startSession")["ok"] == .bool(true))
    }
}

@MainActor
struct AlarmsBridgeTests {
    let policy = LinkPolicy(host: URL(string: "https://hobwork.example.com")!)
    let store = MemoryPermissionStore()
    let prompter = FakePrompter(answer: true)
    let presenter = FakePresenter()
    let scheduler = FakeAlarmScheduler()
    let records = temporaryFile([AlarmRecord]())
    let id = "6a1d3b3e-8a55-4f4c-9d6f-0a2f5b0c7e11"

    func origin(_ hob: String) -> HobOrigin {
        policy.hobOrigin(scheme: "https", host: "\(hob).apps.hobwork.example.com", port: nil)!
    }

    func router(authorized: Bool = true) -> BridgeRouter {
        let router = BridgeRouter(gatekeeper: BridgeGatekeeper(store: store, prompter: prompter)) { _, _ in true }
        router.register(AlarmsBridge(capability: AlarmsCapability(scheduler: scheduler, records: records)) { authorized })
        return router
    }

    func call(_ router: BridgeRouter, _ hob: String, _ method: String, _ args: String = "null") async -> JSONValue {
        let body = JSONValue.object(["capability": .string("alarms"), "method": .string(method), "args": json(args), "page": .string("p1")])
        return await router.handle(body: body, origin: origin(hob), frame: Frame(), presenter: presenter)
    }

    @Test func keepsEachHobToItsOwnAlarms() async {
        let router = router()
        let timer = #"{"id":"\#(id)","title":"Oven","seconds":2700,"repeat":{"seconds":900,"title":"+15 min"},"hob":"sleep"}"#
        #expect(await call(router, "filament", "timer", timer)["value"] == json(#"{"id":"\#(id)"}"#))
        #expect(records.read().first?.hob == "filament")
        #expect(records.read().first?.repeatSeconds == 900)
        #expect(prompter.questions == ["Let “filament” set alarms and timers?"])

        #expect(await call(router, "sleep", "list")["value"] == .array([]))
        #expect(await call(router, "filament", "list")["value"]?.arrayValue?.count == 1)
        #expect(await call(router, "sleep", "cancel", #"{"id":"\#(id)"}"#)["ok"] == .bool(true))
        #expect(scheduler.cancelled.count == 1)
        #expect(await call(router, "sleep", "reschedule", #"{"id":"\#(id)","seconds":60}"#)["error"]?["reason"] == .string("unknown_alarm"))
        #expect(await call(router, "sleep", "timer", #"{"id":"\#(id)","title":"Mine","seconds":60}"#)["error"]?["code"] == .string("failed"))

        #expect(await call(router, "filament", "reschedule", #"{"id":"\#(id)","repeat":null}"#)["ok"] == .bool(true))
        #expect(records.read().first?.repeatSeconds == nil)
        #expect(await call(router, "filament", "cancel", #"{"id":"\#(id)"}"#)["ok"] == .bool(true))
        #expect(records.read().isEmpty)
    }

    @Test func refusesWhenAlarmsAreOff() async {
        let reply = await call(router(authorized: false), "filament", "timer", #"{"title":"Tea","seconds":60}"#)
        #expect(reply["error"]?["code"] == .string("denied"))
        #expect(scheduler.scheduled.isEmpty)
    }
}

@MainActor
struct AlarmEventReporterTests {
    let records = temporaryFile([AlarmRecord(id: "6a1d3b3e-8a55-4f4c-9d6f-0a2f5b0c7e11", title: "Dehydrator", seconds: 60, repeatSeconds: 7200, hob: "filament")])
    let states = temporaryFile([String: String]())
    let id = UUID(uuidString: "6a1d3b3e-8a55-4f4c-9d6f-0a2f5b0c7e11")!

    final class Sink {
        var kinds: [AlarmEventKind] = []
        var reports: [AlarmEventReporter.Report] = []
    }

    func reporter(_ sink: Sink) -> AlarmEventReporter {
        AlarmEventReporter(records: records, states: states) { report in
            sink.kinds.append(report.kind)
            sink.reports.append(report)
        }
    }

    @Test func reportsRingsAndAnswersOnce() async {
        let sink = Sink()
        let reporter = reporter(sink)
        await reporter.observe([ScheduledAlarm(id: id, state: .countdown)])
        await reporter.observe([ScheduledAlarm(id: id, state: .alerting)])
        await reporter.observe([ScheduledAlarm(id: id, state: .alerting)])
        // The repeat intent and AlarmKit's update both see the same tap.
        await reporter.answered(.repeated, id: id)
        await reporter.observe([ScheduledAlarm(id: id, state: .countdown)])
        await reporter.observe([ScheduledAlarm(id: id, state: .alerting)])
        await reporter.observe([])
        await reporter.answered(.stopped, id: id)
        #expect(sink.kinds == [.fired, .repeated, .fired, .stopped])
        #expect(sink.reports[1] == AlarmEventReporter.Report(
            kind: .repeated, hob: "filament",
            data: json(#"{"id":"6a1d3b3e-8a55-4f4c-9d6f-0a2f5b0c7e11","title":"Dehydrator","seconds":7200}"#)
        ))
    }

    @Test func reportsTheRingFirstWhenTheAppMissedIt() async {
        let sink = Sink()
        await reporter(sink).answered(.stopped, id: id)
        #expect(sink.kinds == [.fired, .stopped])
    }

    @Test func ignoresAlarmsWithoutAHob() async {
        records.update { $0[0].hob = nil }
        let sink = Sink()
        await reporter(sink).observe([ScheduledAlarm(id: id, state: .alerting)])
        #expect(sink.kinds.isEmpty)
    }
}

@MainActor
struct HapticsBridgeTests {
    func router(supported: Bool) -> BridgeRouter {
        let router = BridgeRouter(gatekeeper: BridgeGatekeeper(store: MemoryPermissionStore(), prompter: FakePrompter(answer: true))) { _, _ in true }
        router.register(HapticsBridge(supported: supported))
        return router
    }

    @Test func listsHapticsOnlyWithAHapticEngine() {
        #expect(router(supported: true).manifest["haptics"] == ["error", "impact", "lift", "success", "tick", "warning"])
        #expect(router(supported: false).manifest["haptics"] == nil)
    }
}
