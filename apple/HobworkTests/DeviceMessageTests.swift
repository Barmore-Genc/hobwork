import Foundation
import Testing
@testable import Hobwork

struct DeviceMessageTests {
    func json(_ message: DeviceMessage) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(message.encoded().utf8))
    }

    @Test func encodesHelloWithPush() throws {
        let hello = Hello(
            appVersion: "0.1.0 (1)",
            platform: "ios",
            capabilities: ["notifications"],
            push: HostPushGrant(grant: "g1", key: "a2V5")
        )
        #expect(try json(.hello(hello)) == .object([
            "type": .string("hello"),
            "appVersion": .string("0.1.0 (1)"),
            "platform": .string("ios"),
            "capabilities": .array([.string("notifications")]),
            "push": .object(["grant": .string("g1"), "key": .string("a2V5")]),
        ]))
    }

    @Test func decodesThePushMessage() throws {
        let keys = try DeviceMessage.decode(#"{"type":"push","relay":"https://relay.bgenc.dev","signingKey":"cw==","encryptionKey":"ZQ==","keyId":"k1"}"#)
        #expect(keys == .push(HostPushKeys(relay: "https://relay.bgenc.dev", signingKey: "cw==", encryptionKey: "ZQ==", keyId: "k1")))
        #expect(try DeviceMessage.decode(#"{"type":"push","relay":null}"#) == .push(nil))
    }

    @Test func encodesTheTimeZone() throws {
        let hello = Hello(appVersion: "1", platform: "ios", capabilities: [], push: nil, timeZone: "Europe/Istanbul")
        #expect(try json(.hello(hello))["timeZone"] == .string("Europe/Istanbul"))
        #expect(try json(.hello(Hello(appVersion: "1", platform: "ios", capabilities: [])))["timeZone"] == nil)
    }

    @Test func leavesOutPushWithoutAGrant() throws {
        let hello = Hello(appVersion: "1", platform: "ios", capabilities: [], push: nil)
        #expect(try json(.hello(hello))["push"] == nil)
    }

    @Test func decodesCallsWithStringOrNumberIds() throws {
        let call = try DeviceMessage.decode(#"{"type":"call","id":"c1","capability":"notifications","method":"send","args":{"title":"Hi","n":2,"ok":true,"x":null}}"#)
        #expect(call == .call(DeviceCall(
            id: .string("c1"),
            capability: "notifications",
            method: "send",
            args: .object(["title": .string("Hi"), "n": .number(2), "ok": .bool(true), "x": .null])
        )))
        let numbered = try DeviceMessage.decode(#"{"type":"call","id":42,"capability":"nfc","method":"read"}"#)
        #expect(numbered == .call(DeviceCall(id: .number(42), capability: "nfc", method: "read", args: nil)))
    }

    @Test func encodesResults() throws {
        let ok = DeviceMessage.result(DeviceCallResult(id: .number(42), outcome: .success(.object(["id": .string("n1")]))))
        #expect(try json(ok) == .object([
            "type": .string("result"),
            "id": .number(42),
            "ok": .bool(true),
            "value": .object(["id": .string("n1")]),
        ]))
        let failed = DeviceMessage.result(DeviceCallResult(id: .string("c1"), outcome: .failure(CallError(code: "unsupported", message: "No"))))
        #expect(try json(failed) == .object([
            "type": .string("result"),
            "id": .string("c1"),
            "ok": .bool(false),
            "error": .object(["code": .string("unsupported"), "message": .string("No")]),
        ]))
    }

    @Test func encodesNullValuesExplicitly() throws {
        let message = DeviceMessage.result(DeviceCallResult(id: .string("c1"), outcome: .success(.null)))
        #expect(try message.encoded().contains(#""value":null"#))
    }

    @Test func roundTripsEveryMessage() throws {
        let messages: [DeviceMessage] = [
            .hello(Hello(appVersion: "1", platform: "ios", capabilities: ["notifications"], push: nil)),
            .call(DeviceCall(id: .string("a"), capability: "notifications", method: "send", args: .object([:]))),
            .result(DeviceCallResult(id: .string("a"), outcome: .success(.array([.number(1)])))),
            .result(DeviceCallResult(id: .string("a"), outcome: .failure(CallError(code: "failed", message: "x")))),
            .event(DeviceEvent(capability: "notifications", name: "action", data: .object(["action": .string("ok")]))),
            .ping,
            .pong,
        ]
        for message in messages {
            #expect(try DeviceMessage.decode(message.encoded()) == message)
        }
    }

    @Test func encodesEvents() throws {
        let event = DeviceEvent(capability: "notifications", name: "action", data: .object(["action": .string("reorder")]))
        #expect(try json(.event(event)) == .object([
            "type": .string("event"),
            "capability": .string("notifications"),
            "name": .string("action"),
            "data": .object(["action": .string("reorder")]),
        ]))
    }

    @Test func pingAndPongAreJustATypes() throws {
        #expect(try DeviceMessage.ping.encoded() == #"{"type":"ping"}"#)
        #expect(try DeviceMessage.pong.encoded() == #"{"type":"pong"}"#)
        #expect(try DeviceMessage.decode(#"{"type":"ping"}"#) == .ping)
    }

    @Test func keepsUnknownTypes() throws {
        #expect(try DeviceMessage.decode(#"{"type":"later","x":1}"#) == .unknown("later"))
    }

    @Test func rejectsMessagesWithoutAType() {
        #expect(throws: DecodingError.self) { try DeviceMessage.decode(#"{"id":1}"#) }
    }
}
