#if os(macOS)
    import AppKit
#else
    import UIKit
#endif
import CoreGraphics
import Foundation
import Testing
import UserNotifications
@testable import Hobwork

@MainActor
final class FakePresenter: BridgePresenter {
    #if os(macOS)
        var bridgeWindow: NSWindow? { nil }
        var bridgeView: NSView? { nil }
    #else
        var bridgeViewController: UIViewController? { nil }
        var bridgeView: UIView? { nil }
    #endif
}

@MainActor
final class FakePrompter: BridgePrompter {
    var answer: Bool?
    var questions: [String] = []
    var delay: Duration = .zero

    init(answer: Bool?) {
        self.answer = answer
    }

    func ask(title: String, message: String, presenter: any BridgePresenter) async -> Bool? {
        questions.append(title)
        if delay > .zero { try? await Task.sleep(for: delay) }
        return answer
    }
}

@MainActor
final class MemoryPermissionStore: BridgePermissionStore {
    var all: [String: [String: Bool]] = [:]

    func decision(hob: String, key: String) -> Bool? { all[hob]?[key] }
    func set(_ allowed: Bool?, hob: String, key: String) { all[hob, default: [:]][key] = allowed }
    func forget(hob: String) { all[hob] = nil }
}

@MainActor
final class EchoCapability: BridgeCapability {
    let name = "echo"
    let methods = ["say", "secret", "fail", "crash", "ping"]

    func permission(for method: String) -> BridgePermission? {
        guard method == "secret" else { return nil }
        return BridgePermission(key: "echo.secret", label: "Secrets", title: { "Let \($0) know?" }, message: "")
    }

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        switch method {
        case "fail": throw BridgeError.cancelled("closed")
        case "crash": throw CocoaError(.fileNoSuchFile)
        case "ping":
            context.emit("pong", args)
            return .null
        default: return .object(["said": args, "hob": .string(context.origin.hob)])
        }
    }
}

final class Frame {}

@MainActor
struct BridgeTests {
    let policy = LinkPolicy(host: URL(string: "https://hobwork.example.com")!)
    let store = MemoryPermissionStore()
    let prompter = FakePrompter(answer: true)
    let presenter = FakePresenter()
    var delivered: [(Frame, String)] = []

    var filament: HobOrigin { policy.hobOrigin(scheme: "https", host: "filament.apps.hobwork.example.com", port: nil)! }
    var sleep: HobOrigin { policy.hobOrigin(scheme: "https", host: "sleep.apps.hobwork.example.com", port: nil)! }

    func router(deliver: @escaping BridgeRouter.Deliver = { _, _ in true }) -> BridgeRouter {
        let router = BridgeRouter(gatekeeper: BridgeGatekeeper(store: store, prompter: prompter), deliver: deliver)
        router.register(EchoCapability())
        return router
    }

    func body(_ capability: String, _ method: String, _ args: JSONValue = .null, page: String = "p1") -> JSONValue {
        .object(["capability": .string(capability), "method": .string(method), "args": args, "page": .string(page)])
    }

    func errorCode(_ reply: JSONValue) -> String? {
        reply["error"]?["code"]?.stringValue
    }

    // MARK: Origins

    @Test func findsTheHobOfAnAppOrigin() {
        #expect(filament.hob == "filament")
        #expect(filament.branch == nil)
        #expect(filament.string == "https://filament.apps.hobwork.example.com")
        let preview = policy.hobOrigin(scheme: "https", host: "Add-Spools--filament.apps.hobwork.example.com", port: 8443)
        #expect(preview?.hob == "filament")
        #expect(preview?.branch == "add-spools")
        #expect(preview?.string == "https://add-spools--filament.apps.hobwork.example.com:8443")
        #expect(preview?.permissionKey == filament.permissionKey)
        #expect(policy.hobOrigin(scheme: "https", host: "filament.apps.example.com", port: nil)?.hob == "filament")
    }

    @Test(arguments: [
        ("https", "hobwork.example.com"),
        ("https", "apps.hobwork.example.com"),
        ("https", "a.b.apps.hobwork.example.com"),
        ("https", "filament.hobwork.example.com"),
        ("https", "filament.apps.example.org"),
        ("https", "filament.apps.hobwork.example.com.evil.net"),
        ("http", "filament.apps.hobwork.example.com"),
        ("https", "--filament.apps.hobwork.example.com"),
    ])
    func refusesOtherOrigins(scheme: String, host: String) {
        #expect(policy.hobOrigin(scheme: scheme, host: host, port: nil) == nil)
    }

    @Test func answersHobFramesOnlyInsideHobworkOrTheSameHob() {
        func origin(_ host: String, main: Bool, top: String?) -> HobOrigin? {
            policy.bridgeOrigin(scheme: "https", host: host, port: nil, isMainFrame: main, topLevel: top.flatMap(URL.init(string:)))
        }
        let app = "filament.apps.hobwork.example.com"
        #expect(origin(app, main: true, top: "https://\(app)/") == filament)
        #expect(origin(app, main: false, top: "https://hobwork.example.com/projects/filament") == filament)
        #expect(origin(app, main: false, top: "https://\(app)/spools") == filament)
        #expect(origin(app, main: false, top: "https://sleep.apps.hobwork.example.com/") == nil)
        #expect(origin(app, main: false, top: "https://example.com/") == nil)
        #expect(origin(app, main: false, top: "http://hobwork.example.com/") == nil)
        #expect(origin(app, main: false, top: nil) == nil)
        #expect(origin("hobwork.example.com", main: true, top: "https://hobwork.example.com/") == nil)
        #expect(origin("example.com", main: false, top: "https://hobwork.example.com/") == nil)
    }

    @Test func pageScriptListsTheHobHostsAndCapabilities() {
        let source = BridgeScript.source(appsHosts: policy.appsHosts, platform: "ios", manifest: ["haptics": ["success", "tick"]])
        #expect(source.contains(#"[".apps.hobwork.example.com",".apps.example.com"]"#))
        #expect(source.contains(#"{"haptics":["success","tick"]}"#))
        #expect(source.contains("version: 1"))
        #expect(source.contains("platform: 'ios'"))
    }

    // MARK: Calls

    @Test func runsCallsAndAnswersWithTheValue() async {
        let reply = await router().handle(body: body("echo", "say", .string("hi")), origin: filament, frame: Frame(), presenter: presenter)
        #expect(reply == .object(["ok": .bool(true), "value": .object(["said": .string("hi"), "hob": .string("filament")])]))
    }

    @Test func listsMethodsInTheManifest() {
        #expect(router().manifest == ["echo": ["crash", "fail", "ping", "say", "secret"]])
    }

    @Test func answersUnknownCapabilitiesAndMethodsAsUnavailable() async {
        let router = router()
        #expect(errorCode(await router.handle(body: body("nfc", "read"), origin: filament, frame: Frame(), presenter: presenter)) == "unavailable")
        #expect(errorCode(await router.handle(body: body("echo", "shout"), origin: filament, frame: Frame(), presenter: presenter)) == "unavailable")
        #expect(errorCode(await router.handle(body: .object([:]), origin: filament, frame: Frame(), presenter: presenter)) == "failed")
    }

    @Test func passesBridgeErrorsAndTurnsOthersIntoFailed() async {
        let router = router()
        let cancelled = await router.handle(body: body("echo", "fail"), origin: filament, frame: Frame(), presenter: presenter)
        #expect(cancelled["error"] == .object(["code": .string("cancelled"), "message": .string("closed")]))
        #expect(errorCode(await router.handle(body: body("echo", "crash"), origin: filament, frame: Frame(), presenter: presenter)) == "failed")
    }

    // MARK: Permissions

    @Test func asksOncePerHobAndRemembers() async {
        let router = router()
        #expect(await router.handle(body: body("echo", "secret"), origin: filament, frame: Frame(), presenter: presenter)["ok"] == .bool(true))
        #expect(await router.handle(body: body("echo", "secret"), origin: filament, frame: Frame(), presenter: presenter)["ok"] == .bool(true))
        #expect(prompter.questions == ["Let filament know?"])
        #expect(store.all == [filament.permissionKey: ["echo.secret": true]])

        prompter.answer = false
        #expect(errorCode(await router.handle(body: body("echo", "secret"), origin: sleep, frame: Frame(), presenter: presenter)) == "denied")
        #expect(errorCode(await router.handle(body: body("echo", "secret"), origin: sleep, frame: Frame(), presenter: presenter)) == "denied")
        #expect(prompter.questions.count == 2)
        #expect(await router.handle(body: body("echo", "say"), origin: sleep, frame: Frame(), presenter: presenter)["ok"] == .bool(true))
    }

    @Test func asksOnceForCallsThatArriveTogether() async {
        let router = router()
        prompter.delay = .milliseconds(50)
        async let first = router.handle(body: body("echo", "secret"), origin: filament, frame: Frame(), presenter: presenter)
        async let second = router.handle(body: body("echo", "secret"), origin: filament, frame: Frame(), presenter: presenter)
        let replies = await [first, second]
        #expect(replies.allSatisfy { $0["ok"] == .bool(true) })
        #expect(prompter.questions.count == 1)
    }

    @Test func doesNotRememberAQuestionThatCouldNotBeShown() async {
        prompter.answer = nil
        #expect(errorCode(await router().handle(body: body("echo", "secret"), origin: filament, frame: Frame(), presenter: presenter)) == "denied")
        #expect(store.all.isEmpty)
    }

    // MARK: Events

    @Test func sendsEventsToSubscribedPagesOfTheHob() async throws {
        var sent: [(Frame, String)] = []
        let router = router { frame, script in
            sent.append((frame as! Frame, script))
            return true
        }
        let page = Frame()
        let other = Frame()
        let subscribe = body("bridge", "subscribe", .object(["event": .string("echo.pong")]))
        #expect(await router.handle(body: subscribe, origin: filament, frame: page, presenter: presenter)["ok"] == .bool(true))
        _ = await router.handle(body: body("bridge", "subscribe", .object(["event": .string("echo.pong")]), page: "p2"), origin: sleep, frame: other, presenter: presenter)

        _ = await router.handle(body: body("echo", "ping", .object(["n": .number(1)])), origin: filament, frame: Frame(), presenter: presenter)
        try await Task.sleep(for: .milliseconds(20))
        #expect(sent.count == 1)
        #expect(sent.first?.0 === page)
        #expect(sent.first?.1.contains(#"("p1", "https:\/\/filament.apps.hobwork.example.com", "echo.pong", {"n":1})"#) == true)

        _ = await router.handle(body: body("bridge", "unsubscribe", .object(["event": .string("echo.pong")])), origin: filament, frame: page, presenter: presenter)
        _ = await router.handle(body: body("echo", "ping"), origin: filament, frame: Frame(), presenter: presenter)
        try await Task.sleep(for: .milliseconds(20))
        #expect(sent.count == 1)
        #expect(router.subscriptionCount == 1)
    }

    @Test func forgetsPagesThatAreGone() async throws {
        let router = router { _, _ in false }
        _ = await router.handle(body: body("bridge", "subscribe", .object(["event": .string("echo.pong")])), origin: filament, frame: Frame(), presenter: presenter)
        #expect(router.subscriptionCount == 1)
        router.emit("echo.pong", data: .null, to: filament)
        try await Task.sleep(for: .milliseconds(20))
        #expect(router.subscriptionCount == 0)
    }

    @Test func sendsHobEventsToItsBranchPreviewsToo() async throws {
        var scripts: [String] = []
        let router = router { _, script in
            scripts.append(script)
            return true
        }
        let preview = policy.hobOrigin(scheme: "https", host: "add-spools--filament.apps.hobwork.example.com", port: nil)!
        let subscribe = body("bridge", "subscribe", .object(["event": .string("alarms.fired")]))
        _ = await router.handle(body: subscribe, origin: preview, frame: Frame(), presenter: presenter)
        _ = await router.handle(body: body("bridge", "subscribe", .object(["event": .string("alarms.fired")]), page: "p2"), origin: sleep, frame: Frame(), presenter: presenter)
        #expect(router.listens("alarms.fired", hob: "filament"))
        #expect(!router.listens("alarms.fired", origin: filament))
        #expect(router.listens("alarms.fired", origin: preview))
        #expect(!router.listens("nfc.scanned", hob: "filament"))
        router.emit("alarms.fired", data: .object(["id": .string("a1")]), toHob: "filament")
        try await Task.sleep(for: .milliseconds(20))
        #expect(scripts.count == 1)
        #expect(scripts.first?.contains(preview.host) == true)
    }

    @Test func anotherHobCannotUnsubscribeAPage() async {
        let router = router()
        _ = await router.handle(body: body("bridge", "subscribe", .object(["event": .string("echo.pong")])), origin: filament, frame: Frame(), presenter: presenter)
        _ = await router.handle(body: body("bridge", "unsubscribe", .object(["event": .string("echo.pong")])), origin: sleep, frame: Frame(), presenter: presenter)
        #expect(router.subscriptionCount == 1)
        #expect(errorCode(await router.handle(body: body("bridge", "subscribe", .object([:])), origin: filament, frame: Frame(), presenter: presenter)) == "failed")
    }

    // MARK: Capabilities

    @Test func readsAndWritesTheClipboard() async throws {
        final class Board: Clipboard {
            var text: String? = "https://example.com/model"
            func read() -> (text: String?, url: URL?) { (text, text.flatMap(URL.init(string:))) }
            func write(_ text: String) { self.text = text }
        }
        let board = Board()
        let clipboard = ClipboardBridge(clipboard: board)
        #expect(clipboard.permission(for: "read")?.key == "clipboard.read")
        #expect(clipboard.permission(for: "write") == nil)
        let context = BridgeContext(origin: filament, presenter: presenter) { _, _ in }
        let read = try await clipboard.call("read", args: .null, context: context)
        #expect(read == .object(["text": .string("https://example.com/model"), "url": .string("https://example.com/model")]))
        _ = try await clipboard.call("write", args: .object(["text": .string("PLA")]), context: context)
        #expect(board.text == "PLA")
    }

    @Test func buildsLocalNotifications() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let args: JSONValue = .object([
            "id": .string("dryer"), "title": .string("Dryer done"), "body": .string("PLA is dry"),
            "thread": .string("dryer"), "open": .string("/dryer"), "interruptionLevel": .string("timeSensitive"),
            "deliverAt": .string(ISODate.format(now.addingTimeInterval(7200))),
        ])
        let (id, request) = try LocalNotificationsBridge.request(args, hob: "filament", now: now)
        #expect(id == "dryer")
        #expect(request.identifier == "local:filament:dryer")
        #expect(request.content.threadIdentifier == "filament/dryer")
        #expect(request.content.interruptionLevel == .timeSensitive)
        let trigger = try #require(request.trigger as? UNCalendarNotificationTrigger)
        #expect(trigger.nextTriggerDate() == now.addingTimeInterval(7200))
        let payload = NotificationPayload(userInfo: request.content.userInfo)
        #expect(NotificationPayload.link(project: payload?.project, open: payload?.open) == "/p/filament/dryer")

        let (_, immediate) = try LocalNotificationsBridge.request(.object(["title": .string("Hi"), "sound": .string("none")]), hob: "filament", now: now)
        #expect(immediate.trigger == nil)
        #expect(immediate.content.sound == nil)
        #expect(immediate.content.threadIdentifier == "filament")
    }

    @Test(arguments: [
        #"{"body":"no title"}"#,
        #"{"title":"x","id":"has space"}"#,
        #"{"title":"x","interruptionLevel":"critical"}"#,
        #"{"title":"x","sound":"chime"}"#,
        #"{"title":"x","open":"https://example.com"}"#,
        #"{"title":"x","deliverAt":"tomorrow"}"#,
    ])
    func refusesBadLocalNotifications(json: String) throws {
        let args = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        #expect(throws: BridgeError.self) { try LocalNotificationsBridge.request(args, hob: "filament", now: Date()) }
    }

    @Test func readsPrintJobs() throws {
        let pdf = Self.pdf(size: CGSize(width: 175, height: 82))
        let job = try PrintBridge.job(.object(["data": .string(pdf.base64EncodedString())]), hob: "filament")
        #expect(job.mediaSize == CGSize(width: 175, height: 82))
        #expect(job.jobName == "filament")
        #expect(job.dialog)

        let sized = try PrintBridge.job(.object([
            "data": .string(pdf.base64EncodedString()), "mediaSize": .object(["width": .number(100), "height": .number(50)]),
            "printer": .string("ipp://label.local"), "dialog": .bool(false), "jobName": .string("Spool 42"),
        ]), hob: "filament")
        #expect(sized.mediaSize == CGSize(width: 100, height: 50))
        #expect(sized.printer == "ipp://label.local")
        #expect(!sized.dialog)

        #expect(throws: BridgeError.self) { try PrintBridge.job(.object(["data": .string("bm90IGEgcGRm")]), hob: "filament") }
        #expect(throws: BridgeError.self) {
            try PrintBridge.job(.object(["data": .string(pdf.base64EncodedString()), "dialog": .bool(false)]), hob: "filament")
        }
        #expect(throws: BridgeError.self) {
            try PrintBridge.job(.object(["data": .string(pdf.base64EncodedString()), "mediaSize": .object(["width": .number(0)])]), hob: "filament")
        }
    }

    @Test func remembersRecentPrintersPerHob() throws {
        let defaults = try #require(UserDefaults(suiteName: "bridge-tests-\(UUID().uuidString)"))
        let memory = PrinterMemory(defaults: defaults)
        for index in 0 ..< 12 {
            memory.remember(PrinterMemory.Printer(id: "ipp://\(index)", name: "P\(index)", lastUsedAt: Date()), hob: "a")
        }
        memory.remember(PrinterMemory.Printer(id: "ipp://5", name: "P5", lastUsedAt: Date()), hob: "a")
        #expect(memory.printers(hob: "a").map(\.id).prefix(3) == ["ipp://5", "ipp://11", "ipp://10"])
        #expect(memory.printers(hob: "a").count == PrinterMemory.limit)
        #expect(memory.printers(hob: "b").isEmpty)
        memory.forget(id: "ipp://5", hob: "a")
        #expect(!memory.printers(hob: "a").contains { $0.id == "ipp://5" })
    }

    @Test func sharesFilesUnderASafeName() {
        #expect(ShareBridge.filename("label.pdf") == "label.pdf")
        #expect(ShareBridge.filename("../../etc/passwd") == "passwd")
        #expect(ShareBridge.filename("..") == "file")
        #expect(ShareBridge.filename(nil) == "file")
    }

    static func pdf(size: CGSize) -> Data {
        let data = NSMutableData()
        var box = CGRect(origin: .zero, size: size)
        let consumer = CGDataConsumer(data: data as CFMutableData)!
        let context = CGContext(consumer: consumer, mediaBox: &box, nil)!
        context.beginPDFPage(nil)
        context.endPDFPage()
        context.closePDF()
        return data as Data
    }
}
