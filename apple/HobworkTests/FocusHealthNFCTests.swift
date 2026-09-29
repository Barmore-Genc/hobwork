import CoreNFC
import Foundation
import HealthKit
import Testing
@testable import Hobwork

struct FocusTests {
    @Test func reportsFocusChanges() {
        var labels = FocusLabels()
        #expect(labels.apply(label: "work") == [FocusLabels.event(label: "work", active: true)])
        #expect(labels.active == ["work"])
        #expect(labels.setUp)

        #expect(labels.apply(label: "sleep") == [
            FocusLabels.event(label: "work", active: false),
            FocusLabels.event(label: "sleep", active: true),
        ])
        #expect(labels.apply(label: nil) == [FocusLabels.event(label: "sleep", active: false)])
        #expect(labels.active.isEmpty)
        #expect(labels.apply(label: nil).isEmpty)
    }

    @Test func treatsBlankLabelsAsOff() {
        var labels = FocusLabels(active: ["work"], setUp: true)
        #expect(labels.apply(label: "  ") == [FocusLabels.event(label: "work", active: false)])
        #expect(labels.apply(label: " gym ") == [FocusLabels.event(label: "gym", active: true)])
    }

    @Test func encodesChangedEvents() throws {
        let event = FocusLabels.event(label: "work", active: true)
        #expect(try DeviceMessage.event(event).encoded()
            == #"{"capability":"focus","data":{"active":true,"label":"work"},"name":"changed","type":"event"}"#)
    }

    @Test @MainActor func answersStatus() async throws {
        let file = temporaryFile(FocusLabels())
        file.update { $0.active = ["work"] }
        #expect(try await FocusCapability(file: file).handle(method: "status", args: nil) == json(#"{"active":["work"]}"#))
    }
}

@MainActor
struct HealthTests {
    let reader = FakeHealthReader()

    func makeCapability(sharing: Set<HealthType> = [.steps, .sleep]) -> HealthCapability {
        HealthCapability(reader: reader, sharing: { sharing })
    }

    @Test func parsesQueries() throws {
        let query = try HealthCapability.query(from: Arguments(json(#"{"type":"steps","from":"2026-05-04T00:00:00Z","to":"2026-05-05T00:00:00Z"}"#), call: "q"))
        #expect(query == HealthCapability.Query(type: .steps, from: isoDate("2026-05-04T00:00:00Z"), to: isoDate("2026-05-05T00:00:00Z"), limit: 1000))
        for args in [
            #"{"type":"blood","from":"2026-05-04T00:00:00Z","to":"2026-05-05T00:00:00Z"}"#,
            #"{"type":"steps","from":"2026-05-05T00:00:00Z","to":"2026-05-04T00:00:00Z"}"#,
            #"{"type":"steps","from":"2026-05-04T00:00:00Z","to":"2026-05-05T00:00:00Z","limit":1001}"#,
            #"{"type":"steps","from":"yesterday","to":"2026-05-05T00:00:00Z"}"#,
        ] {
            #expect(throws: CallError.self, "\(args)") { try HealthCapability.query(from: Arguments(json(args), call: "q")) }
        }
    }

    @Test func encodesSamples() async throws {
        reader.samples = [
            HealthSample(type: .steps, start: isoDate("2026-05-04T08:00:00Z"), end: isoDate("2026-05-04T08:10:00Z"), value: 812, unit: "count", source: "iPhone"),
        ]
        let value = try await makeCapability().handle(method: "query", args: json(#"{"type":"steps","from":"2026-05-04T00:00:00Z","to":"2026-05-05T00:00:00Z","limit":10}"#))
        #expect(value == json(#"[{"type":"steps","start":"2026-05-04T08:00:00Z","end":"2026-05-04T08:10:00Z","value":812,"unit":"count","source":"iPhone"}]"#))
        #expect(reader.queries.first?.3 == 10)
    }

    @Test func refusesTypesThatAreNotShared() async {
        await #expect {
            try await makeCapability().handle(method: "query", args: json(#"{"type":"bodyMass","from":"2026-05-04T00:00:00Z","to":"2026-05-05T00:00:00Z"}"#))
        } throws: { ($0 as? CallError)?.code == "not_shared" }
    }

    @Test func reportsALockedPhone() async {
        reader.failure = .locked
        await #expect {
            try await makeCapability().handle(method: "query", args: json(#"{"type":"steps","from":"2026-05-04T00:00:00Z","to":"2026-05-05T00:00:00Z"}"#))
        } throws: { ($0 as? CallError)?.code == "locked" }
    }

    @Test func mapsHealthKitErrors() {
        #expect(HealthKitReader.readError(HKError(.errorDatabaseInaccessible)) == .locked)
        #expect(HealthKitReader.readError(HKError(.errorAuthorizationDenied)) == .notAuthorized)
    }

    @Test func convertsQuantitySamples() throws {
        let start = isoDate("2026-05-04T08:00:00Z")
        let heart = HKQuantitySample(
            type: HKQuantityType(.heartRate),
            quantity: HKQuantity(unit: .count().unitDivided(by: .minute()), doubleValue: 62),
            start: start, end: start
        )
        let sample = try #require(HealthSample(heart, type: .heartRate))
        #expect(sample.value == 62)
        #expect(sample.unit == "count/min")
        #expect(sample.start == "2026-05-04T08:00:00Z")

        let weight = HKQuantitySample(type: HKQuantityType(.bodyMass), quantity: HKQuantity(unit: .pound(), doubleValue: 150), start: start, end: start)
        #expect(try #require(HealthSample(weight, type: .bodyMass)?.value).rounded() == 68)

        let energy = HKQuantitySample(type: HKQuantityType(.activeEnergyBurned), quantity: HKQuantity(unit: .kilocalorie(), doubleValue: 120), start: start, end: start)
        #expect(HealthSample(energy, type: .activeEnergy)?.unit == "kcal")
    }

    @Test func convertsSleepAndMindfulness() throws {
        let start = isoDate("2026-05-04T01:00:00Z")
        let end = isoDate("2026-05-04T01:30:00Z")
        let deep = HKCategorySample(type: HKCategoryType(.sleepAnalysis), value: HKCategoryValueSleepAnalysis.asleepDeep.rawValue, start: start, end: end)
        let sample = try #require(HealthSample(deep, type: .sleep))
        #expect(sample.stage == "deep")
        #expect(sample.value == nil)
        #expect(HealthSample.stage(.inBed) == "inBed")
        #expect(HealthSample.stage(.asleepUnspecified) == "asleep")
        #expect(HealthSample.stage(.asleepREM) == "rem")

        let mindful = HKCategorySample(type: HKCategoryType(.mindfulSession), value: HKCategoryValue.notApplicable.rawValue, start: start, end: end)
        #expect(HealthSample(mindful, type: .mindfulness)?.value == 30)
        #expect(HealthSample(mindful, type: .mindfulness)?.unit == "min")
        #expect(HealthSample(mindful, type: .steps) == nil)
    }

    @Test func namesWorkoutTypes() {
        #expect(HealthSample.name(of: .running) == "running")
        #expect(HealthSample.name(of: .curling) == "other")
    }

    @Test func encodesSampleEvents() throws {
        let samples = [HealthSample(type: .sleep, start: isoDate("2026-05-04T01:00:00Z"), end: isoDate("2026-05-04T01:30:00Z"), stage: "core", source: "Watch")]
        let event = try HealthDelivery.event(type: .sleep, samples: samples)
        #expect(event.capability == "health")
        #expect(event.name == "samples")
        #expect(event.data == json(#"{"type":"sleep","samples":[{"type":"sleep","start":"2026-05-04T01:00:00Z","end":"2026-05-04T01:30:00Z","stage":"core","source":"Watch"}]}"#))
    }

    @Test func keepsSharingStateInTheAppGroupFile() {
        let file = temporaryFile(HealthSharing())
        file.update { $0.shared[.steps] = isoDate("2026-05-04T00:00:00Z") }
        #expect(file.read().types == [.steps])
    }
}

@MainActor
struct NFCTests {
    let host = URL(string: "https://hobwork.example.com")!

    @Test func readsTagLinks() {
        #expect(NFCTagLink.tag(from: URL(string: "hobwork://nfc/t_4f2a")!, host: nil) == "t_4f2a")
        #expect(NFCTagLink.tag(from: URL(string: "https://hobwork.example.com/nfc/t_4f2a")!, host: host) == "t_4f2a")
        #expect(NFCTagLink.tag(from: URL(string: "https://HOBWORK.example.com/nfc/abc-1")!, host: host) == "abc-1")
    }

    @Test func ignoresOtherLinks() {
        for link in [
            "hobwork://paired?code=1",
            "hobwork://nfc/",
            "hobwork://nfc/a/b",
            "https://other.example.com/nfc/abc",
            "http://hobwork.example.com/nfc/abc",
            "https://hobwork.example.com:8443/nfc/abc",
            "https://hobwork.example.com/nfc",
            "https://hobwork.example.com/projects/nfc",
            "https://hobwork.example.com/nfc/a%20b",
        ] {
            #expect(NFCTagLink.tag(from: URL(string: link)!, host: host) == nil, "\(link)")
        }
        #expect(NFCTagLink.tag(from: URL(string: "https://hobwork.example.com/nfc/abc")!, host: nil) == nil)
    }

    @Test func encodesScannedEvents() throws {
        #expect(try DeviceMessage.event(NFCTagLink.event(tag: "abc")).encoded()
            == #"{"capability":"nfc","data":{"tag":"abc"},"name":"scanned","type":"event"}"#)
    }

    @Test func findsTheTagInTheFirstLink() {
        let records = [
            NFCRecord(type: .text, value: "Kitchen"),
            NFCRecord(type: .url, value: "https://hobwork.example.com/nfc/abc"),
            NFCRecord(type: .url, value: "https://hobwork.example.com/nfc/def"),
        ]
        #expect(NFCCapability.readResult(records, host: host).tag == "abc")
        #expect(NFCCapability.readResult([NFCRecord(type: .url, value: "https://example.com/nfc/abc")], host: host).tag == nil)
    }

    @Test func readsAndWritesThroughTheSession() async throws {
        let session = FakeNFCSession()
        session.records = [NFCRecord(type: .url, value: "https://hobwork.example.com/nfc/abc")]
        let capability = NFCCapability(session: session, host: { self.host })
        #expect(try await capability.handle(method: "read", args: nil)
            == json(#"{"records":[{"type":"url","value":"https://hobwork.example.com/nfc/abc"}],"tag":"abc"}"#))

        let written = try await capability.handle(method: "write", args: json(#"{"tag":"abc","url":"https://hobwork.example.com/nfc/abc","text":"Kitchen"}"#))
        #expect(written == json(#"{"tag":"abc"}"#))
        #expect(session.written.first?.0.absoluteString == "https://hobwork.example.com/nfc/abc")
        #expect(session.written.first?.1 == "Kitchen")
    }

    @Test func mapsSessionErrors() async {
        let session = FakeNFCSession()
        let capability = NFCCapability(session: session, host: { nil })
        for (error, code) in [(NFCSessionError.cancelled, "cancelled"), (.notWritable, "not_writable"), (.tooSmall, "too_small")] {
            session.failure = error
            await #expect { try await capability.handle(method: "read", args: nil) } throws: { ($0 as? CallError)?.code == code }
        }
        session.failure = nil
        await #expect {
            try await capability.handle(method: "write", args: json(#"{"tag":"abc","url":"ftp://x"}"#))
        } throws: { ($0 as? CallError)?.code == "bad_request" }
        session.isAvailable = false
        await #expect { try await capability.handle(method: "read", args: nil) } throws: { ($0 as? CallError)?.code == "unsupported" }
    }

    @Test func buildsAndReadsNDEFRecords() throws {
        let url = URL(string: "https://hobwork.example.com/nfc/abc")!
        let message = try #require(NDEFTagSession.message(url: url, text: "Kitchen"))
        #expect(message.records.map(NDEFTagSession.record) == [
            NFCRecord(type: .url, value: url.absoluteString),
            NFCRecord(type: .text, value: "Kitchen"),
        ])
        #expect(NDEFTagSession.message(url: url, text: nil)?.records.count == 1)
        let raw = NFCNDEFPayload(format: .nfcExternal, type: Data("x:y".utf8), identifier: Data(), payload: Data([1, 2, 3]))
        #expect(NDEFTagSession.record(raw) == NFCRecord(type: .other, value: "AQID"))
    }
}
