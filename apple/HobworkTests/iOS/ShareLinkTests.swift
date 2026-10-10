import Foundation
import Testing
@testable import Hobwork

struct HobLinkRoutingTests {
    let policy = LinkPolicy(host: URL(string: "https://hobwork.example.com")!)
    let rules = HobLinkRules(
        include: ["/spool/*", "/bin/?"],
        exclude: HobLinkRules.default.exclude + ["/photos", "/photos/*", "/spool/print"]
    )

    var filament: HobOrigin { policy.hobOrigin(of: URL(string: "https://filament.apps.hobwork.example.com")!)! }

    @Test func matchesPathsLikeTheAssociationFile() {
        #expect(HobLinkRules.default.opensApp(path: "/"))
        #expect(HobLinkRules.default.opensApp(path: "/spool/78"))
        #expect(!HobLinkRules.default.opensApp(path: "/_hobwork/callback"))
        #expect(!HobLinkRules.default.opensApp(path: "/api/spools"))
        #expect(rules.opensApp(path: "/spool/78"))
        #expect(rules.opensApp(path: "/bin/4"))
        #expect(!rules.opensApp(path: "/bin/14"))
        #expect(!rules.opensApp(path: "/spool/print"))
        #expect(!rules.opensApp(path: "/photos/2026/cat.jpg"))
        #expect(!rules.opensApp(path: "/"))
        #expect(HobLinkRules.matches("/a/b/c", "/a/*/c"))
        #expect(!HobLinkRules.matches("/a/b/d", "/a/*/c"))
    }

    @Test func deliversToAListeningPageAndLoadsOtherwise() {
        let url = URL(string: "https://filament.apps.hobwork.example.com/spool/78?from=tag")!
        let deliver = HobLinkRouter.action(for: url, origin: filament, rules: rules) { $0 == "link.opened" }
        #expect(deliver == .deliver(filament, .object(["url": .string(url.absoluteString), "path": .string("/spool/78?from=tag")])))
        #expect(HobLinkRouter.action(for: url, origin: filament, rules: rules) { $0 == "nfc.scanned" } == .scanned)
        #expect(HobLinkRouter.action(for: url, origin: filament, rules: rules) { _ in false } == .load(url))
        let excluded = URL(string: "https://filament.apps.hobwork.example.com/spool/print")!
        #expect(HobLinkRouter.action(for: excluded, origin: filament, rules: rules) { _ in true } == .browser(excluded))
        let root = URL(string: "https://filament.apps.hobwork.example.com")!
        #expect(HobLinkRouter.action(for: root, origin: filament, rules: .default) { _ in false } == .load(root))
    }

    @Test @MainActor func keepsRulesForAWhileAndFallsBackToTheDefaults() async {
        let cache = HobLinkRulesCache()
        let host = URL(string: "https://hobwork.example.com")!
        var fetches = 0
        let hobs = [HostHob(hob: "filament", widget: false, intents: [], appLinks: rules)]
        #expect(await cache.rules(for: "filament", host: host) { fetches += 1; return hobs } == rules)
        #expect(await cache.rules(for: "sleep", host: host) { fetches += 1; return hobs } == .default)
        #expect(fetches == 1)
        let other = URL(string: "https://other.example.com")!
        #expect(await cache.rules(for: "filament", host: other) { throw HostError.notHobwork } == .default)
    }

    @Test func decodesShareTargetsAndRulesAndOlderHobLists() throws {
        let json = """
        {"hobs":[{"hob":"filament","widget":false,"intents":[],
          "share":[{"id":"queue","title":"Add to the queue","accepts":{"urls":true,"text":false,"files":["model/3mf",".3mf"]},"maxBytes":209715200}],
          "appLinks":{"include":["/spool/*"],"exclude":["/api/*"]}},
          {"hob":"sleep","widget":true,"intents":[]}]}
        """
        struct Response: Decodable { var hobs: [HostHob] }
        let hobs = try JSONDecoder().decode(Response.self, from: Data(json.utf8)).hobs
        #expect(hobs[0].share == [HostShareTarget(id: "queue", title: "Add to the queue", accepts: .init(urls: true, text: false, files: ["model/3mf", ".3mf"]), maxBytes: 209_715_200)])
        #expect(hobs[0].appLinks == HobLinkRules(include: ["/spool/*"], exclude: ["/api/*"]))
        #expect(hobs[1].share == nil && hobs[1].appLinks == nil)
    }
}

struct ShareTargetTests {
    let queue = HostShareTarget(id: "queue", title: "Add to the queue", accepts: .init(urls: true, text: false, files: ["model/3mf", ".3mf"]), maxBytes: 1000)
    let notes = HostShareTarget(id: "note", title: "Add a note", accepts: .init(urls: false, text: true, files: []), maxBytes: nil)
    let photos = HostShareTarget(id: "photo", title: "Identify a spool", accepts: .init(urls: false, text: false, files: ["image/*"]), maxBytes: 5000)

    var hobs: [HostHob] {
        [
            HostHob(hob: "filament", widget: false, intents: [], share: [queue, photos]),
            HostHob(hob: "notes", widget: false, intents: [], share: [notes]),
            HostHob(hob: "sleep", widget: true, intents: []),
        ]
    }

    func file(_ name: String, type: String?, size: Int = 10) -> SharedFileItem {
        SharedFileItem(file: URL(filePath: "/tmp/\(name)"), name: name, contentType: type, size: size)
    }

    @Test func textThatIsALinkCountsAsTheLink() {
        let items = SharedItems(text: " https://makerworld.com/en/models/1052418 ")
        #expect(items.url?.absoluteString == "https://makerworld.com/en/models/1052418")
        #expect(items.text == nil)
        #expect(SharedItems(url: URL(string: "https://a.example/x"), text: "https://a.example/x").text == nil)
        #expect(SharedItems(text: "Buy https://a.example/x").url == nil)
        #expect(SharedItems(url: URL(string: "file:///tmp/a")).isEmpty)
    }

    @Test func offersTargetsThatTakeSomethingOfIt() {
        let link = SharedItems(url: URL(string: "https://makerworld.com/en/models/1"))
        #expect(ShareMatch.options(hobs: hobs, items: link).map(\.id) == ["filament/queue", "notes/note"])
        #expect(ShareMatch.payload(for: notes, items: link) == SharePayload(url: nil, text: "https://makerworld.com/en/models/1", files: []))

        let model = SharedItems(files: [file("Headphone stand.3MF", type: nil), file("cat.heic", type: "image/heic")])
        #expect(ShareMatch.options(hobs: hobs, items: model).map(\.id) == ["filament/queue", "filament/photo"])
        #expect(ShareMatch.payload(for: queue, items: model)?.files.map(\.name) == ["Headphone stand.3MF"])
        #expect(ShareMatch.options(hobs: hobs, items: SharedItems(files: [file("a.pdf", type: "application/pdf")])).isEmpty)
    }

    @Test func saysWhenAFileIsTooLarge() throws {
        let payload = try #require(ShareMatch.payload(for: queue, items: SharedItems(files: [file("big.3mf", type: "model/3mf", size: 5000)])))
        #expect(ShareMatch.problem(for: queue, payload: payload)?.hasPrefix("big.3mf is too large. Add to the queue takes files up to") == true)
        #expect(ShareMatch.problem(for: photos, payload: payload) == nil)
    }

    @Test func matchesTypesLikeTheHost() {
        #expect(ShareMatch.accepts([".3mf"], name: "Model.3MF", contentType: nil))
        #expect(ShareMatch.accepts(["model/3mf"], name: "x", contentType: "model/3mf; charset=binary"))
        #expect(ShareMatch.accepts(["image/*"], name: "x", contentType: "image/png"))
        #expect(!ShareMatch.accepts(["image/*"], name: "x.png", contentType: nil))
        #expect(ShareMatch.mimeType(for: nil, name: "a.3mf") != nil)
    }

    @Test func offersTheLastChoiceFirst() throws {
        let defaults = try #require(UserDefaults(suiteName: "share-\(UUID().uuidString)"))
        let store = ShareChoiceStore(defaults: defaults)
        let options = ShareMatch.options(hobs: hobs, items: SharedItems(url: URL(string: "https://a.example/")))
        #expect(store.preferred(in: options)?.id == "filament/queue")
        store.remember(options[1])
        #expect(store.preferred(in: options)?.id == "notes/note")
        #expect(store.preferred(in: [options[0]])?.id == "filament/queue")
    }
}

/// Answers the share endpoints like the host, keeping the uploaded bytes.
final class FakeShareHost: ShareTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var requests: [(method: String, path: String, query: String?, bytes: Int)] = []
    private(set) var stored = Data()
    private(set) var shared: JSONValue?
    var failNextPart = false
    var shareAnswer: JSONValue = .object(["ok": .bool(true), "say": .string("Added Headphone stand to the queue.")])
    let size: Int
    let chunk: Int

    init(size: Int, chunk: Int) {
        self.size = size
        self.chunk = chunk
    }

    func send(_ request: URLRequest, body: Data?) async throws -> (Data, Int) {
        try lock.withLock { try answer(request, body: body) }
    }

    private func answer(_ request: URLRequest, body: Data?) throws -> (Data, Int) {
        let url = try #require(request.url)
        let method = request.httpMethod ?? "GET"
        requests.append((method, url.path(), url.query(), body?.count ?? request.httpBody?.count ?? 0))
        func status(_ code: Int = 200) -> (Data, Int) {
            let value: JSONValue = .object([
                "id": .string("u1"), "path": .string("inbox/model.3mf"), "size": .number(Double(size)),
                "received": .number(Double(stored.count)), "chunkBytes": .number(Double(chunk)),
            ])
            return (try! JSONEncoder().encode(value), code)
        }
        switch (method, url.path()) {
        case ("POST", "/api/devices/uploads"): return status(201)
        case ("GET", "/api/devices/uploads/filament/queue/u1"): return status()
        case ("PUT", "/api/devices/uploads/filament/queue/u1"):
            let offset = Int(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? "") ?? -1
            guard offset == stored.count, let body else { return status(409) }
            stored.append(body)
            if failNextPart {
                failNextPart = false
                throw URLError(.networkConnectionLost)
            }
            if stored.count == size { return (Data(#"{"done":true,"file":{"path":"inbox/model.3mf"}}"#.utf8), 201) }
            return status()
        case ("POST", "/api/devices/share"):
            shared = try JSONDecoder().decode(JSONValue.self, from: #require(request.httpBody))
            return (try JSONEncoder().encode(shareAnswer), 200)
        default:
            return (Data(#"{"error":"not found"}"#.utf8), 404)
        }
    }
}

struct ShareSenderTests {
    let api = HostAPI(host: URL(string: "https://hobwork.example.com")!, token: "device-token")

    func modelFile(size: Int) throws -> SharedFileItem {
        let url = FileManager.default.temporaryDirectory.appending(path: "share-test-\(UUID().uuidString).3mf")
        try Data((0 ..< size).map { UInt8($0 % 251) }).write(to: url)
        return SharedFileItem(file: url, name: "Headphone stand.3mf", contentType: "model/3mf", size: size)
    }

    @Test func uploadsInPartsFromTheFileAndRunsTheRoute() async throws {
        let item = try modelFile(size: 25)
        defer { try? FileManager.default.removeItem(at: item.file) }
        let host = FakeShareHost(size: 25, chunk: 10)
        host.failNextPart = true
        let sender = ShareSender(api: api, transport: host)
        let progress = ProgressLog()
        let payload = SharePayload(url: URL(string: "https://makerworld.com/en/models/1"), text: nil, files: [item])
        let say = try await sender.send(hob: "filament", target: "queue", payload: payload) { progress.add($0) }
        #expect(say == "Added Headphone stand to the queue.")
        #expect(host.stored == (try Data(contentsOf: item.file)))
        // The dropped part was stored; the sender asked where the upload stands and went on.
        #expect(host.requests.map(\.method) == ["POST", "PUT", "GET", "PUT", "PUT", "POST"])
        #expect(host.requests.filter { $0.method == "PUT" }.map(\.query) == ["offset=0", "offset=10", "offset=20"])
        #expect(host.shared?["files"] == .array([.object([
            "path": .string("inbox/model.3mf"), "name": .string("Headphone stand.3mf"), "size": .number(25), "contentType": .string("model/3mf"),
        ])]))
        #expect(host.shared?["url"] == .string("https://makerworld.com/en/models/1"))
        #expect(host.shared?["target"] == .string("queue"))
        #expect(progress.values.last == ShareProgress(stage: .sending, sent: 25, total: 25))
        #expect(progress.values.contains(ShareProgress(stage: .uploading(file: 0), sent: 20, total: 25)))
    }

    @Test func saysWhatTheHobOrHostRefused() async throws {
        let host = FakeShareHost(size: 0, chunk: 10)
        host.shareAnswer = .object(["ok": .bool(false), "error": .object(["code": .string("route_failed"), "message": .string("The hob answered 500")])])
        let sender = ShareSender(api: api, transport: host)
        let payload = SharePayload(url: URL(string: "https://a.example/"), text: nil, files: [])
        await #expect(throws: ShareError(message: "The hob answered 500")) {
            try await sender.send(hob: "filament", target: "queue", payload: payload) { _ in }
        }
        let item = try modelFile(size: 5)
        defer { try? FileManager.default.removeItem(at: item.file) }
        let other = ShareSender(api: api, transport: FakeShareHost(size: 5, chunk: 10))
        await #expect(throws: ShareError(message: "not found")) {
            try await other.send(hob: "other", target: "queue", payload: SharePayload(files: [item])) { _ in }
        }
    }
}

final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var log: [ShareProgress] = []

    func add(_ value: ShareProgress) {
        lock.withLock { log.append(value) }
    }

    var values: [ShareProgress] {
        lock.withLock { log }
    }
}

private extension SharePayload {
    init(files: [SharedFileItem]) {
        self.init(url: nil, text: nil, files: files)
    }
}
