#if os(iOS)
    import CoreGraphics
    import Foundation
    import UIKit
    import Vision

    enum CameraAccess: Sendable {
        case allowed
        /// The person refused Hobwork the camera in the Settings app.
        case denied
        /// Screen Time or a profile blocks the camera.
        case restricted
    }

    struct CameraPhotoOptions: Equatable, Sendable {
        var maxDimension = 1600
        var quality = 0.8
    }

    struct CameraButton: Equatable, Sendable {
        var id: String
        var label: String
    }

    struct CameraScanOptions: Equatable, Sendable {
        /// Empty reads every kind.
        var symbologies: [VNBarcodeSymbology] = []
        /// Report UPC-A codes (EAN-13 starting with 0) as `upca`.
        var upca = false
        var multiple = false
        var torch = false
        var guidance: String?
        /// Fractions of the camera view.
        var regionOfInterest: CGRect?
        var shutter = false
        var photo = CameraPhotoOptions()
        var buttons: [CameraButton] = []
    }

    /// A code in view, as the scanner reports it.
    struct CameraCode: Equatable, Sendable {
        var id: String
        var payload: String
        var symbology: VNBarcodeSymbology
        /// Fractions of the camera view.
        var bounds: CGRect
    }

    struct CameraPhoto: Equatable, Sendable {
        var jpeg: Data
        var width: Int
        var height: Int
    }

    enum CameraScanEnd: Equatable, Sendable {
        /// The person tapped this code.
        case tapped(CameraCode)
        case stopped
        case cancelled
        case failed(String)
    }

    enum CameraError: Error, Equatable {
        case unsupported
        case busy
        case cancelled
        case failed(String)
    }

    /// What the scanner tells the bridge while it runs.
    struct CameraScanEvents {
        var codes: @MainActor ([CameraCode]) -> Void
        var button: @MainActor (String) -> Void
        /// A photo from the scanner's shutter button.
        var photo: @MainActor (CameraPhoto) -> Void
        /// The person switched the torch.
        var torch: @MainActor (Bool) -> Void
        /// Once, also after `stopScan`.
        var ended: @MainActor (CameraScanEnd) -> Void
    }

    /// The camera UI: a VisionKit data scanner and the system camera, or a fake in tests.
    @MainActor
    protocol CameraDevice: AnyObject {
        var canScan: Bool { get }
        var canTakePhotos: Bool { get }
        /// Asks iOS for the camera the first time.
        func access() async -> CameraAccess
        func startScan(_ options: CameraScanOptions, presenter: any BridgePresenter, events: CameraScanEvents) throws(CameraError)
        func updateScan(guidance: String?)
        func setTorch(_ on: Bool) throws(CameraError)
        func capture(_ options: CameraPhotoOptions) async throws(CameraError) -> CameraPhoto
        func stopScan()
        func takePhoto(_ options: CameraPhotoOptions, presenter: any BridgePresenter) async throws(CameraError) -> CameraPhoto
    }

    /// `camera` for hob pages: a live barcode scanner over the page that reports codes in
    /// view (`camera.codes`), buttons (`camera.button`), shutter photos (`camera.photo`) and
    /// the torch (`camera.torch`), and ends once (`camera.ended`) on a code, a stop or the
    /// close button; still photos from the running scanner (`capture`); and one photo with
    /// the system camera (`photo`). Asks the person once per hob.
    @MainActor
    final class CameraBridge: BridgeCapability {
        static let maxButtons = 3

        let name = "camera"
        private let device: any CameraDevice
        private var scan: (id: String, origin: HobOrigin)?
        private var takingPhoto = false

        init(device: any CameraDevice) {
            self.device = device
        }

        var methods: [String] {
            var methods: [String] = []
            if device.canScan { methods += ["startScan", "updateScan", "setTorch", "capture", "stopScan"] }
            if device.canTakePhotos { methods.append("photo") }
            return methods
        }

        func permission(for method: String) -> BridgePermission? {
            guard method == "startScan" || method == "photo" else { return nil }
            return BridgePermission(
                key: "camera",
                label: "Use the camera",
                title: { "Let “\($0)” use the camera?" },
                message: "It can then scan barcodes and take photos while you have it open."
            )
        }

        func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
            switch method {
            case "startScan":
                let options = try Self.scanOptions(args)
                try await authorize()
                return try start(options, context: context)
            case "photo":
                let options = try Self.photoOptions(args)
                guard scan == nil, !takingPhoto else { throw Self.busy }
                try await authorize()
                takingPhoto = true
                defer { takingPhoto = false }
                return Self.photoJSON(try await run { () throws(CameraError) in try await device.takePhoto(options, presenter: context.presenter) })
            case "updateScan":
                try current(args, origin: context.origin)
                device.updateScan(guidance: try Self.guidance(args))
                return .null
            case "setTorch":
                try current(args, origin: context.origin)
                guard let on = try args.bool("on") else { throw BridgeError.failed("on is required") }
                try run { () throws(CameraError) in try device.setTorch(on) }
                return .null
            case "capture":
                try current(args, origin: context.origin)
                let options = try Self.photoOptions(args)
                return Self.photoJSON(try await run { () throws(CameraError) in try await device.capture(options) })
            default:
                try current(args, origin: context.origin)
                device.stopScan()
                return .null
            }
        }

        private func authorize() async throws {
            switch await device.access() {
            case .allowed: return
            case .denied: throw BridgeError.denied("Hobwork isn't allowed to use the camera. Allow it in the Settings app.")
            case .restricted: throw BridgeError(code: .unavailable, message: "The camera is restricted on this device", reason: "restricted")
            }
        }

        private func start(_ options: CameraScanOptions, context: BridgeContext) throws -> JSONValue {
            guard scan == nil, !takingPhoto else { throw Self.busy }
            let id = UUID().uuidString.lowercased()
            let emit = context.emit
            let upca = options.upca
            let multiple = options.multiple
            let session = JSONValue.string(id)
            let end: @MainActor (CameraScanEnd?, CameraCode?) -> Void = { [weak self] end, selected in
                guard let self, scan?.id == id else { return }
                scan = nil
                var data: [String: JSONValue] = ["session": session]
                switch end {
                case nil, .tapped:
                    data["reason"] = .string("selected")
                    if let selected { data["code"] = Self.codeJSON(selected, upca: upca) }
                case .stopped: data["reason"] = .string("stopped")
                case .cancelled: data["reason"] = .string("cancelled")
                case let .failed(message):
                    data["reason"] = .string("failed")
                    data["message"] = .string(message)
                }
                emit("ended", .object(data))
            }
            let events = CameraScanEvents(
                codes: { [weak self] codes in
                    guard self?.scan?.id == id else { return }
                    emit("codes", .object(["session": session, "codes": .array(codes.map { Self.codeJSON($0, upca: upca) })]))
                    // Without `multiple` the first code read is the answer.
                    if !multiple, let first = codes.first {
                        end(nil, first)
                        self?.device.stopScan()
                    }
                },
                button: { [weak self] button in
                    guard self?.scan?.id == id else { return }
                    emit("button", .object(["session": session, "id": .string(button)]))
                },
                photo: { [weak self] photo in
                    guard self?.scan?.id == id else { return }
                    var data = Self.photoJSON(photo).objectValue ?? [:]
                    data["session"] = session
                    emit("photo", .object(data))
                },
                torch: { [weak self] on in
                    guard self?.scan?.id == id else { return }
                    emit("torch", .object(["session": session, "on": .bool(on)]))
                },
                ended: { reason in
                    if case let .tapped(code) = reason { end(reason, code) } else { end(reason, nil) }
                }
            )
            scan = (id, context.origin)
            do {
                try device.startScan(options, presenter: context.presenter, events: events)
            } catch {
                scan = nil
                throw Self.bridgeError(error)
            }
            return .object(["session": session])
        }

        /// Only the page's own hob may change or stop its scan.
        private func current(_ args: JSONValue, origin: HobOrigin) throws {
            let id = try args.requiredString("session")
            guard let scan, scan.id == id, scan.origin.hob == origin.hob else { throw BridgeError.failed("This scan has ended") }
        }

        private func run<Value>(_ body: () async throws(CameraError) -> Value) async throws(BridgeError) -> Value {
            do {
                return try await body()
            } catch {
                throw Self.bridgeError(error)
            }
        }

        private func run(_ body: () throws(CameraError) -> Void) throws(BridgeError) {
            do {
                try body()
            } catch {
                throw Self.bridgeError(error)
            }
        }

        private static let busy = BridgeError.failed("The camera is already open", reason: "busy")

        static func bridgeError(_ error: CameraError) -> BridgeError {
            switch error {
            case .unsupported: BridgeError(code: .unavailable, message: "This device can't scan with its camera", reason: "unsupported")
            case .busy: busy
            case .cancelled: .cancelled("No photo was taken")
            case let .failed(message): .failed(message)
            }
        }

        // MARK: Arguments and answers

        /// Page names to Vision's; `upca` reads as EAN-13.
        static let symbologies: [String: VNBarcodeSymbology] = [
            "ean13": .ean13, "ean8": .ean8, "upca": .ean13, "upce": .upce,
            "code39": .code39, "code93": .code93, "code128": .code128,
            "itf14": .itf14, "i2of5": .i2of5, "codabar": .codabar, "gs1DataBar": .gs1DataBar,
            "qr": .qr, "microQR": .microQR, "dataMatrix": .dataMatrix,
            "pdf417": .pdf417, "microPDF417": .microPDF417, "aztec": .aztec, "msiPlessey": .msiPlessey,
        ]

        static func symbologyName(_ symbology: VNBarcodeSymbology) -> String {
            symbologies.first { $0.value == symbology && $0.key != "upca" }?.key ?? symbology.rawValue
        }

        static func scanOptions(_ args: JSONValue) throws(BridgeError) -> CameraScanOptions {
            var options = CameraScanOptions()
            if let names = args["symbologies"], names != .null {
                guard let list = names.arrayValue else { throw .failed("symbologies must be a list") }
                for name in list {
                    guard let name = name.stringValue, let symbology = symbologies[name] else {
                        throw .failed("symbologies takes \(symbologies.keys.sorted().joined(separator: ", "))")
                    }
                    if name == "upca" { options.upca = true }
                    if !options.symbologies.contains(symbology) { options.symbologies.append(symbology) }
                }
            }
            options.multiple = try args.bool("multiple") ?? false
            options.torch = try args.bool("torch") ?? false
            options.guidance = try guidance(args)
            options.shutter = try args.bool("shutter") ?? false
            if let photo = args["photo"], photo != .null { options.photo = try photoOptions(photo) }
            if let region = args["regionOfInterest"], region != .null {
                guard let x = try region.number("x"), let y = try region.number("y"),
                      let width = try region.number("width"), let height = try region.number("height"),
                      x >= 0, y >= 0, width > 0, height > 0, x + width <= 1.0001, y + height <= 1.0001
                else { throw .failed("regionOfInterest must be { x, y, width, height } within 0 to 1") }
                options.regionOfInterest = CGRect(x: x, y: y, width: width, height: height)
            }
            if let buttons = args["buttons"], buttons != .null {
                guard let list = buttons.arrayValue, list.count <= maxButtons else { throw .failed("buttons must be a list of at most \(maxButtons)") }
                options.buttons = try list.map { (button: JSONValue) throws(BridgeError) -> CameraButton in
                    let label = try button.requiredString("label")
                    guard label.count <= 40 else { throw .failed("Button labels must be at most 40 characters") }
                    return CameraButton(id: try button.requiredString("id"), label: label)
                }
            }
            return options
        }

        static func photoOptions(_ args: JSONValue) throws(BridgeError) -> CameraPhotoOptions {
            var options = CameraPhotoOptions()
            if let size = try args.number("maxDimension") {
                guard size >= 100, size <= 4096 else { throw .failed("maxDimension must be 100 to 4096") }
                options.maxDimension = Int(size)
            }
            if let quality = try args.number("quality") {
                guard quality >= 0.1, quality <= 1 else { throw .failed("quality must be 0.1 to 1") }
                options.quality = quality
            }
            return options
        }

        static func guidance(_ args: JSONValue) throws(BridgeError) -> String? {
            guard let text = try args.string("guidance") else { return nil }
            guard text.count <= 120 else { throw .failed("guidance must be at most 120 characters") }
            return text.isEmpty ? nil : text
        }

        static func codeJSON(_ code: CameraCode, upca: Bool) -> JSONValue {
            var payload = code.payload
            var symbology = symbologyName(code.symbology)
            if upca, code.symbology == .ean13, payload.count == 13, payload.hasPrefix("0") {
                payload.removeFirst()
                symbology = "upca"
            }
            func round(_ value: CGFloat) -> JSONValue { .number((Double(value) * 10000).rounded() / 10000) }
            return .object([
                "id": .string(code.id),
                "payload": .string(payload),
                "symbology": .string(symbology),
                "bounds": .object([
                    "x": round(code.bounds.minX), "y": round(code.bounds.minY),
                    "width": round(code.bounds.width), "height": round(code.bounds.height),
                ]),
            ])
        }

        static func photoJSON(_ photo: CameraPhoto) -> JSONValue {
            .object([
                "data": .string(photo.jpeg.base64EncodedString()),
                "type": .string("image/jpeg"),
                "width": .number(Double(photo.width)),
                "height": .number(Double(photo.height)),
            ])
        }
    }

    extension CameraPhoto {
        /// A JPEG of `image` with its longer side at most `maxDimension` pixels, upright, then
        /// turned clockwise by `quarterTurns` (negative for counterclockwise).
        static func jpeg(_ image: UIImage, options: CameraPhotoOptions, quarterTurns: Int = 0) -> CameraPhoto? {
            let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
            guard pixels.width >= 1, pixels.height >= 1 else { return nil }
            let factor = min(1, CGFloat(options.maxDimension) / max(pixels.width, pixels.height))
            let drawn = CGSize(width: max(1, (pixels.width * factor).rounded()), height: max(1, (pixels.height * factor).rounded()))
            let size = quarterTurns % 2 != 0 ? CGSize(width: drawn.height, height: drawn.width) : drawn
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let resized = UIGraphicsImageRenderer(size: size, format: format).image { context in
                context.cgContext.translateBy(x: size.width / 2, y: size.height / 2)
                context.cgContext.rotate(by: CGFloat(quarterTurns) * .pi / 2)
                image.draw(in: CGRect(x: -drawn.width / 2, y: -drawn.height / 2, width: drawn.width, height: drawn.height))
            }
            guard let data = resized.jpegData(compressionQuality: options.quality) else { return nil }
            return CameraPhoto(jpeg: data, width: Int(size.width), height: Int(size.height))
        }

        /// The scanner's stills are upright for a device held in portrait whatever the screen
        /// shows, so they are turned to match the screen. Stills that already match are left alone.
        static func quarterTurns(for interface: UIInterfaceOrientation, imageSize: CGSize) -> Int {
            let portraitImage = imageSize.height > imageSize.width
            switch interface {
            case .landscapeRight: return portraitImage ? -1 : 0
            case .landscapeLeft: return portraitImage ? 1 : 0
            case .portraitUpsideDown: return 2
            default: return 0
            }
        }
    }
#endif
