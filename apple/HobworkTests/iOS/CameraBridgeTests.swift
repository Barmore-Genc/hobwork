import Foundation
import Testing
import UIKit
import Vision
@testable import Hobwork

@MainActor
final class FakeCamera: CameraDevice {
    var canScan = true
    var canTakePhotos = true
    var accessAnswer = CameraAccess.allowed
    var started: [CameraScanOptions] = []
    var events: CameraScanEvents?
    var guidance: [String?] = []
    var torch: [Bool] = []
    var captured: [CameraPhotoOptions] = []
    var stops = 0
    var photo = CameraPhoto(jpeg: Data([1, 2, 3]), width: 1600, height: 1200)
    var photoFailure: CameraError?

    func access() async -> CameraAccess { accessAnswer }

    func startScan(_ options: CameraScanOptions, presenter: any BridgePresenter, events: CameraScanEvents) throws(CameraError) {
        started.append(options)
        self.events = events
    }

    func updateScan(guidance: String?) { self.guidance.append(guidance) }
    func setTorch(_ on: Bool) throws(CameraError) { torch.append(on) }

    func capture(_ options: CameraPhotoOptions) async throws(CameraError) -> CameraPhoto {
        captured.append(options)
        return photo
    }

    /// The scanner reports its end after a stop, as VisionKitCamera does.
    func stopScan() {
        stops += 1
        events?.ended(.stopped)
    }

    func takePhoto(_ options: CameraPhotoOptions, presenter: any BridgePresenter) async throws(CameraError) -> CameraPhoto {
        captured.append(options)
        if let photoFailure { throw photoFailure }
        return photo
    }
}

@MainActor
struct CameraBridgeTests {
    let policy = LinkPolicy(host: URL(string: "https://hobwork.example.com")!)
    let store = MemoryPermissionStore()
    let prompter = FakePrompter(answer: true)
    let presenter = FakePresenter()
    let camera = FakeCamera()
    let delivered = Delivered()
    let frame = Frame()

    var filament: HobOrigin { policy.hobOrigin(scheme: "https", host: "filament.apps.hobwork.example.com", port: nil)! }
    var other: HobOrigin { policy.hobOrigin(scheme: "https", host: "other.apps.hobwork.example.com", port: nil)! }

    let code = CameraCode(id: "c1", payload: "0042853002314", symbology: .ean13, bounds: CGRect(x: 0.2, y: 0.4, width: 0.6, height: 0.1))

    func router() -> BridgeRouter {
        let delivered = delivered
        let router = BridgeRouter(gatekeeper: BridgeGatekeeper(store: store, prompter: prompter)) { _, script in
            delivered.scripts.append(script)
            return true
        }
        router.register(CameraBridge(device: camera))
        return router
    }

    func call(_ router: BridgeRouter, _ method: String, _ args: String = "null", origin: HobOrigin? = nil) async -> JSONValue {
        let body = JSONValue.object(["capability": .string("camera"), "method": .string(method), "args": json(args), "page": .string("p1")])
        return await router.handle(body: body, origin: origin ?? filament, frame: frame, presenter: presenter)
    }

    func subscribe(_ router: BridgeRouter, _ events: String...) async {
        for event in events {
            let body = JSONValue.object([
                "capability": .string("bridge"), "method": .string("subscribe"),
                "args": .object(["event": .string(event)]), "page": .string("p1"),
            ])
            _ = await router.handle(body: body, origin: filament, frame: frame, presenter: presenter)
        }
    }

    func settle() async throws {
        try await Task.sleep(for: .milliseconds(50))
    }

    @Test func listsWhatTheDeviceSupports() {
        #expect(router().manifest["camera"] == ["capture", "photo", "setTorch", "startScan", "stopScan", "updateScan"])
        camera.canScan = false
        #expect(router().manifest["camera"] == ["photo"])
        camera.canTakePhotos = false
        #expect(router().manifest["camera"] == nil)
    }

    @Test func readsScanOptions() async throws {
        let reply = await call(router(), "startScan", #"""
        {"symbologies":["upca","ean13","qr"],"multiple":true,"torch":true,"guidance":"Still looking for a barcode",
         "regionOfInterest":{"x":0.1,"y":0.3,"width":0.8,"height":0.3},"shutter":true,"photo":{"maxDimension":1200,"quality":0.6},
         "buttons":[{"id":"ai","label":"Read the label with AI"},{"id":"type","label":"Type it in"}]}
        """#)
        #expect(reply["ok"] == .bool(true))
        let options = try #require(camera.started.first)
        #expect(options.symbologies == [.ean13, .qr])
        #expect(options.upca == true)
        #expect(options.multiple == true)
        #expect(options.torch == true)
        #expect(options.guidance == "Still looking for a barcode")
        #expect(options.regionOfInterest == CGRect(x: 0.1, y: 0.3, width: 0.8, height: 0.3))
        #expect(options.photo == CameraPhotoOptions(maxDimension: 1200, quality: 0.6))
        #expect(options.buttons == [CameraButton(id: "ai", label: "Read the label with AI"), CameraButton(id: "type", label: "Type it in")])
        #expect(prompter.questions == ["Let “filament” use the camera?"])
    }

    @Test(arguments: [
        #"{"symbologies":["barcode"]}"#,
        #"{"regionOfInterest":{"x":0.5,"y":0,"width":0.8,"height":1}}"#,
        #"{"buttons":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"},{"id":"d","label":"D"}]}"#,
        #"{"photo":{"maxDimension":10000}}"#,
        #"{"photo":{"quality":0}}"#,
    ])
    func refusesBadOptions(args: String) async {
        #expect(await call(router(), "startScan", args)["error"]?["code"] == .string("failed"))
        #expect(camera.started.isEmpty)
    }

    @Test func endsOnTheFirstCodeAndReportsUPCA() async throws {
        let router = router()
        await subscribe(router, "camera.codes", "camera.ended")
        let started = await call(router, "startScan", #"{"symbologies":["upca"]}"#)
        let id = try #require(started["value"]?["session"]?.stringValue)
        camera.events?.codes([code])
        try await settle()
        #expect(camera.stops == 1)
        let ended = try #require(delivered.scripts.first { $0.contains("\"camera.ended\"") })
        #expect(ended.contains(#""reason":"selected""#))
        #expect(ended.contains(#""payload":"042853002314""#))
        #expect(ended.contains(#""symbology":"upca""#))
        #expect(ended.contains(id))
        #expect(!delivered.scripts.contains { $0.contains(#""reason":"stopped""#) })
        #expect(await call(router, "capture", #"{"session":"\#(id)"}"#)["error"]?["code"] == .string("failed"))
    }

    @Test func streamsCodesButtonsPhotosAndTheTorchUntilStopped() async throws {
        let router = router()
        await subscribe(router, "camera.codes", "camera.button", "camera.photo", "camera.torch", "camera.ended")
        let started = await call(router, "startScan", #"{"multiple":true,"shutter":true}"#)
        let id = try #require(started["value"]?["session"]?.stringValue)
        #expect(await call(router, "startScan")["error"]?["reason"] == .string("busy"))
        #expect(await call(router, "photo")["error"]?["reason"] == .string("busy"))

        camera.events?.codes([code])
        camera.events?.button("ai")
        camera.events?.photo(CameraPhoto(jpeg: Data([1, 2, 3]), width: 800, height: 600))
        camera.events?.torch(true)
        try await settle()
        #expect(camera.stops == 0)
        #expect(delivered.contains(#""symbology":"ean13""#))
        #expect(delivered.contains(#""id":"ai""#))
        #expect(delivered.contains(#""data":"AQID""#))
        #expect(delivered.contains(#""on":true"#))

        let photo = await call(router, "capture", #"{"session":"\#(id)","maxDimension":1000,"quality":0.5}"#)
        #expect(photo["value"] == json(#"{"data":"AQID","type":"image/jpeg","width":1600,"height":1200}"#))
        #expect(camera.captured == [CameraPhotoOptions(maxDimension: 1000, quality: 0.5)])
        _ = await call(router, "setTorch", #"{"session":"\#(id)","on":true}"#)
        #expect(camera.torch == [true])
        _ = await call(router, "updateScan", #"{"session":"\#(id)","guidance":"Barcode found"}"#)
        #expect(camera.guidance == ["Barcode found"])

        #expect(await call(router, "stopScan", #"{"session":"\#(id)"}"#, origin: other)["error"]?["code"] == .string("failed"))
        _ = await call(router, "stopScan", #"{"session":"\#(id)"}"#)
        try await settle()
        #expect(delivered.contains(#""reason":"stopped""#))
        #expect(await call(router, "setTorch", #"{"session":"\#(id)","on":false}"#)["error"]?["code"] == .string("failed"))
    }

    @Test func endsWithTheTappedCodeOrTheReason() async throws {
        let router = router()
        await subscribe(router, "camera.ended")
        _ = await call(router, "startScan", #"{"multiple":true}"#)
        camera.events?.ended(.tapped(code))
        _ = await call(router, "startScan", #"{"multiple":true}"#)
        camera.events?.ended(.failed("The camera stopped"))
        try await settle()
        #expect(delivered.contains(#""payload":"0042853002314""#))
        #expect(delivered.contains(#""message":"The camera stopped""#))
    }

    @Test func refusalsAndUnsupportedDevices() async {
        prompter.answer = false
        #expect(await call(router(), "startScan")["error"]?["code"] == .string("denied"))
        #expect(camera.started.isEmpty)

        prompter.answer = true
        store.forget(hob: filament.permissionKey)
        camera.accessAnswer = .denied
        #expect(await call(router(), "photo")["error"]?["code"] == .string("denied"))
        camera.accessAnswer = .restricted
        #expect(await call(router(), "photo")["error"]?["reason"] == .string("restricted"))
        camera.accessAnswer = .allowed
        camera.photoFailure = .cancelled
        #expect(await call(router(), "photo")["error"]?["code"] == .string("cancelled"))
        camera.photoFailure = .unsupported
        #expect(await call(router(), "photo")["error"]?["reason"] == .string("unsupported"))

        camera.canScan = false
        #expect(await call(router(), "startScan")["error"]?["code"] == .string("unavailable"))
    }

    @Test func scalesPhotosToTheLongerSide() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4000, height: 3000), format: format).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4000, height: 3000))
        }
        let photo = try #require(CameraPhoto.jpeg(image, options: CameraPhotoOptions(maxDimension: 1600, quality: 0.8)))
        #expect(photo.width == 1600)
        #expect(photo.height == 1200)
        #expect(photo.jpeg.starts(with: [0xFF, 0xD8]))
        let decoded = try #require(UIImage(data: photo.jpeg))
        #expect(decoded.size == CGSize(width: 1600, height: 1200))

        let small = try #require(CameraPhoto.jpeg(image, options: CameraPhotoOptions(maxDimension: 4096, quality: 0.5)))
        #expect(small.width == 4000)
    }

    @Test func turnsScannerStillsToTheScreen() throws {
        let portrait = CGSize(width: 900, height: 1600)
        #expect(CameraPhoto.quarterTurns(for: .landscapeRight, imageSize: portrait) == -1)
        #expect(CameraPhoto.quarterTurns(for: .landscapeLeft, imageSize: portrait) == 1)
        #expect(CameraPhoto.quarterTurns(for: .portrait, imageSize: portrait) == 0)
        #expect(CameraPhoto.quarterTurns(for: .landscapeRight, imageSize: CGSize(width: 1600, height: 900)) == 0)

        // Red on top; a counterclockwise turn puts it on the left.
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: portrait, format: format).image { context in
            UIColor.blue.setFill()
            context.fill(CGRect(origin: .zero, size: portrait))
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 900, height: 800))
        }
        let photo = try #require(CameraPhoto.jpeg(image, options: CameraPhotoOptions(maxDimension: 1600, quality: 0.9), quarterTurns: -1))
        #expect(photo.width == 1600)
        #expect(photo.height == 900)
        let decoded = try #require(UIImage(data: photo.jpeg)?.cgImage)
        let left = try #require(pixel(decoded, x: 100, y: 450))
        let right = try #require(pixel(decoded, x: 1500, y: 450))
        #expect(left.red > 200 && left.blue < 60)
        #expect(right.blue > 200 && right.red < 60)
    }

    private func pixel(_ image: CGImage, x: Int, y: Int) -> (red: UInt8, blue: UInt8)? {
        var data = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(
            data: &data, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        return (data[0], data[2])
    }
}
