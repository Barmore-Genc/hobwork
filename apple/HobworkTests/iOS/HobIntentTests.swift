import Foundation
import Testing
@testable import Hobwork

struct HobLinkTests {
    @Test func readsOpenLinks() throws {
        let link = try #require(HobLink(url: URL(string: "hobwork://open?hob=filament&path=/spools/3")!))
        #expect(link == HobLink(hob: "filament", path: "/spools/3"))
        #expect(link.webPath == "/p/filament/spools/3")
        #expect(HobLink(url: URL(string: "hobwork://open?hob=filament")!)?.webPath == "/p/filament")
        #expect(HobLink(url: URL(string: "hobwork://open?hob=filament&path=spools")!)?.webPath == "/p/filament/spools")
    }

    @Test(arguments: [
        "hobwork://open",
        "hobwork://open?path=/x",
        "hobwork://open?hob=Filament",
        "hobwork://open?hob=../settings",
        "hobwork://nfc/abc",
        "https://open?hob=filament",
    ])
    func refusesOtherLinks(text: String) {
        #expect(HobLink(url: URL(string: text)!) == nil)
    }

    @Test func buildsLinksThatReadBack() throws {
        let link = try #require(HobLink(hob: "kitchen", path: "/timers?oven=1"))
        #expect(HobLink(url: link.url) == link)
        #expect(HobLink(hob: "kitchen", path: nil)?.url.absoluteString == "hobwork://open?hob=kitchen")
    }
}

struct HobCatalogTests {
    let api = HostAPI(host: URL(string: "https://hobwork.example.com")!, token: "device-token")

    func body(_ request: URLRequest) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: #require(request.httpBody))
    }

    @Test func decodesTheHobList() throws {
        let text = """
        {"hobs":[{"hob":"filament","widget":true,"intents":[{"id":"log-spool","title":"Log Spool","parameters":[{"id":"grams","title":"Grams","type":"number","optional":false}],"opensApp":false,"open":null,"runs":true}]}]}
        """
        struct Response: Decodable { var hobs: [HostHob] }
        let hobs = try JSONDecoder().decode(Response.self, from: Data(text.utf8)).hobs
        #expect(hobs == [HostHob(hob: "filament", widget: true, intents: [
            HostHobIntent(id: "log-spool", title: "Log Spool", parameters: [.init(id: "grams", title: "Grams", type: .number, optional: false)], opensApp: false, open: nil, runs: true),
        ])])
        let entity = HobIntentEntity(hob: "filament", intent: hobs[0].intents[0])
        #expect(entity.id == "filament/log-spool")
        #expect(entity.hob == "filament")
        #expect(entity.intent == "log-spool")
    }

    @Test func decodesWidgetContentAndItsRefresh() throws {
        let text = """
        {"title":"Spools","subtitle":"2 low","lines":[{"text":"PLA Black","detail":"120 g","swatches":["#222222"]},{"text":"PETG"}],"swatches":["#FF0000"],"open":"/spools","refreshAt":"2026-10-09T12:00:00Z"}
        """
        let content = try JSONDecoder().decode(WidgetContent.self, from: Data(text.utf8))
        #expect(content.lines?.count == 2)
        #expect(content.lines?[1] == WidgetContent.Line(text: "PETG"))
        let now = isoDate("2026-10-09T11:00:00Z")
        #expect(content.nextRefresh(after: now) == isoDate("2026-10-09T12:00:00Z"))
        #expect(content.nextRefresh(after: isoDate("2026-10-09T13:00:00Z")) == isoDate("2026-10-09T13:30:00Z"))
        #expect(WidgetContent(title: "x").nextRefresh(after: now) == isoDate("2026-10-09T11:30:00Z"))
    }

    @Test func buildsRequests() throws {
        #expect(api.hobsRequest.url?.absoluteString == "https://hobwork.example.com/api/devices/hobs")
        #expect(api.hobsRequest.value(forHTTPHeaderField: "Authorization") == "Bearer device-token")
        #expect(api.widgetRequest(hob: "filament").url?.absoluteString == "https://hobwork.example.com/api/devices/widgets/filament")

        let intent = api.intentRequest(hob: "filament", intent: "log-spool", parameters: ["grams": .number(120), "note": .string("x"), "dry": .bool(true)])
        #expect(intent.httpMethod == "POST")
        #expect(intent.url?.path == "/api/devices/intents")
        #expect(try body(intent) == json(#"{"hob":"filament","intent":"log-spool","parameters":{"grams":120,"note":"x","dry":true}}"#))
        #expect(try body(api.intentRequest(hob: "filament", intent: "open", parameters: [:])) == json(#"{"hob":"filament","intent":"open"}"#))

        let start = api.liveActivityRequest(hob: "filament", op: "start", id: nil, args: json(#"{"title":"Printing"}"#))
        #expect(start.url?.path == "/api/devices/live-activities")
        #expect(try body(start) == json(#"{"hob":"filament","op":"start","args":{"title":"Printing"}}"#))
        let end = api.liveActivityRequest(hob: "filament", op: "end", id: "key-1", args: .object([:]))
        #expect(try body(end) == json(#"{"hob":"filament","op":"end","id":"key-1","args":{}}"#))
    }

    @Test func readsIntentOutcomes() throws {
        #expect(try HostAPI.intentOutcome(json(#"{"ok":true,"say":"Logged.","open":"/spools/3"}"#)) == HobIntentOutcome(say: "Logged.", open: "/spools/3"))
        #expect(try HostAPI.intentOutcome(json(#"{"ok":true}"#)) == HobIntentOutcome())
        #expect(throws: HobIntentError.failed("No spool 9")) {
            try HostAPI.intentOutcome(json(#"{"ok":false,"error":{"code":"failed","message":"No spool 9"}}"#))
        }
    }
}
