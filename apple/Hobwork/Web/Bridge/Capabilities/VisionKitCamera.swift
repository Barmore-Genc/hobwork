#if os(iOS)
    import AVFoundation
    import UIKit
    import Vision
    import VisionKit

    /// The camera for `CameraBridge`: VisionKit's data scanner in a full-screen scanner over
    /// the web view, and `UIImagePickerController` for single photos.
    @MainActor
    final class VisionKitCamera: CameraDevice {
        private var scanner: ScannerController?

        var canScan: Bool { DataScannerViewController.isSupported }
        var canTakePhotos: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

        func access() async -> CameraAccess {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: return .allowed
            case .restricted: return .restricted
            case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .denied
            default: return .denied
            }
        }

        func startScan(_ options: CameraScanOptions, presenter: any BridgePresenter, events: CameraScanEvents) throws(CameraError) {
            guard canScan else { throw .unsupported }
            guard scanner == nil else { throw .busy }
            guard DataScannerViewController.isAvailable else { throw .failed("The camera isn't available right now") }
            guard let parent = Self.top(presenter) else { throw .failed("Nothing to show the scanner on") }
            var events = events
            let ended = events.ended
            events.ended = { [weak self] end in
                self?.scanner = nil
                ended(end)
            }
            let scanner = ScannerController(options: options, events: events)
            self.scanner = scanner
            parent.present(scanner, animated: true)
        }

        func updateScan(guidance: String?) {
            scanner?.guidance = guidance
        }

        func setTorch(_ on: Bool) throws(CameraError) {
            guard let scanner else { throw .failed("This scan has ended") }
            try scanner.setTorch(on)
        }

        func capture(_ options: CameraPhotoOptions) async throws(CameraError) -> CameraPhoto {
            guard let scanner else { throw .failed("This scan has ended") }
            return try await scanner.capture(options)
        }

        func stopScan() {
            scanner?.finish(.stopped)
        }

        func takePhoto(_ options: CameraPhotoOptions, presenter: any BridgePresenter) async throws(CameraError) -> CameraPhoto {
            guard canTakePhotos else { throw .unsupported }
            guard let parent = Self.top(presenter) else { throw .failed("Nothing to show the camera on") }
            let taker = PhotoTaker()
            let image: UIImage?
            do {
                image = try await taker.take(from: parent)
            } catch {
                throw .failed(error.localizedDescription)
            }
            guard let image else { throw .cancelled }
            guard let photo = await Self.encode(image, options: options) else { throw .failed("Couldn't save the photo") }
            return photo
        }

        /// Big photos take a while to scale and compress.
        nonisolated static func encode(_ image: UIImage, options: CameraPhotoOptions, quarterTurns: Int = 0) async -> CameraPhoto? {
            await Task.detached(priority: .userInitiated) { CameraPhoto.jpeg(image, options: options, quarterTurns: quarterTurns) }.value
        }

        private static func top(_ presenter: any BridgePresenter) -> UIViewController? {
            var controller = presenter.bridgeViewController
            while let presented = controller?.presentedViewController, !presented.isBeingDismissed {
                controller = presented
            }
            return controller
        }
    }

    private final class PhotoTaker: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private var continuation: CheckedContinuation<UIImage?, Error>?

        func take(from parent: UIViewController) async throws -> UIImage? {
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.cameraCaptureMode = .photo
            picker.delegate = self
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                parent.present(picker, animated: true)
            }
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            let image = info[.originalImage] as? UIImage
            picker.dismiss(animated: true)
            continuation?.resume(returning: image)
            continuation = nil
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
            continuation?.resume(returning: nil)
            continuation = nil
        }
    }

    /// The scanner: VisionKit's live viewfinder with close and torch buttons, the page's
    /// status text and buttons, and a shutter.
    private final class ScannerController: UIViewController, DataScannerViewControllerDelegate {
        /// Position changes of codes in view are reported at most this often.
        private static let updateInterval: TimeInterval = 0.2

        private let options: CameraScanOptions
        private let events: CameraScanEvents
        private let scanner: DataScannerViewController
        private var lastReport = Date.distantPast
        private var finished = false
        private var torchOn = false
        private var capturing = false

        private let torchButton = UIButton(configuration: .glass())
        private let shutterButton = UIButton(type: .custom)
        private let guidanceLabel = UILabel()
        private let guidancePill = UIVisualEffectView(effect: UIGlassEffect())

        var guidance: String? {
            didSet {
                guard guidance != oldValue else { return }
                showGuidance()
                if let guidance { UIAccessibility.post(notification: .announcement, argument: guidance) }
            }
        }

        init(options: CameraScanOptions, events: CameraScanEvents) {
            self.options = options
            self.events = events
            scanner = DataScannerViewController(
                recognizedDataTypes: [.barcode(symbologies: options.symbologies)],
                qualityLevel: .balanced,
                recognizesMultipleItems: options.multiple,
                isHighFrameRateTrackingEnabled: options.multiple,
                isPinchToZoomEnabled: true,
                isGuidanceEnabled: false,
                isHighlightingEnabled: true
            )
            guidance = options.guidance
            super.init(nibName: nil, bundle: nil)
            modalPresentationStyle = .fullScreen
            overrideUserInterfaceStyle = .dark
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            scanner.delegate = self
            addChild(scanner)
            scanner.view.frame = view.bounds
            scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(scanner.view)
            scanner.didMove(toParent: self)
            layOutControls()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard !finished, !scanner.isScanning else { return }
            do {
                try scanner.startScanning()
            } catch {
                finish(.failed("The camera couldn't start: \(error.localizedDescription)"))
                return
            }
            if options.torch { try? setTorch(true) }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            guard let region = options.regionOfInterest else { return }
            let size = scanner.view.bounds.size
            scanner.regionOfInterest = CGRect(
                x: region.minX * size.width, y: region.minY * size.height,
                width: region.width * size.width, height: region.height * size.height
            )
        }

        // MARK: Controls

        private func layOutControls() {
            var close = UIButton.Configuration.glass()
            close.image = UIImage(systemName: "xmark")
            let closeButton = UIButton(configuration: close, primaryAction: UIAction { [weak self] _ in self?.finish(.cancelled) })
            closeButton.accessibilityLabel = "Close"

            torchButton.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                if (try? setTorch(!torchOn)) != nil { events.torch(torchOn) }
            }, for: .primaryActionTriggered)
            torchButton.accessibilityLabel = "Torch"
            showTorch()

            for button in [closeButton, torchButton] {
                button.translatesAutoresizingMaskIntoConstraints = false
                view.addSubview(button)
                NSLayoutConstraint.activate([
                    button.widthAnchor.constraint(equalToConstant: 44),
                    button.heightAnchor.constraint(equalToConstant: 44),
                    button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
                ])
            }
            NSLayoutConstraint.activate([
                closeButton.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
                torchButton.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            ])

            let foot = UIStackView()
            foot.axis = .vertical
            foot.alignment = .center
            foot.spacing = 14
            foot.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(foot)
            NSLayoutConstraint.activate([
                foot.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
                foot.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
                foot.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            ])

            guidanceLabel.font = .preferredFont(forTextStyle: .subheadline)
            guidanceLabel.adjustsFontForContentSizeCategory = true
            guidanceLabel.textColor = .white
            guidanceLabel.numberOfLines = 2
            guidanceLabel.textAlignment = .center
            guidanceLabel.translatesAutoresizingMaskIntoConstraints = false
            guidancePill.cornerConfiguration = .capsule()
            guidancePill.contentView.addSubview(guidanceLabel)
            NSLayoutConstraint.activate([
                guidanceLabel.leadingAnchor.constraint(equalTo: guidancePill.contentView.leadingAnchor, constant: 16),
                guidanceLabel.trailingAnchor.constraint(equalTo: guidancePill.contentView.trailingAnchor, constant: -16),
                guidanceLabel.topAnchor.constraint(equalTo: guidancePill.contentView.topAnchor, constant: 8),
                guidanceLabel.bottomAnchor.constraint(equalTo: guidancePill.contentView.bottomAnchor, constant: -8),
            ])
            foot.addArrangedSubview(guidancePill)
            showGuidance()

            if !options.buttons.isEmpty {
                let row = UIStackView()
                row.axis = .horizontal
                row.distribution = .fillEqually
                row.spacing = 10
                for button in options.buttons {
                    var configuration = UIButton.Configuration.glass()
                    configuration.title = button.label
                    configuration.titleLineBreakMode = .byTruncatingTail
                    let control = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in
                        guard let self, !finished else { return }
                        events.button(button.id)
                    })
                    control.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
                    row.addArrangedSubview(control)
                }
                foot.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: foot.widthAnchor).isActive = true
            }

            if options.shutter {
                shutterButton.backgroundColor = .white
                shutterButton.layer.cornerRadius = 32
                shutterButton.layer.borderWidth = 4
                shutterButton.layer.borderColor = UIColor.white.withAlphaComponent(0.5).cgColor
                shutterButton.accessibilityLabel = "Take Photo"
                shutterButton.addAction(UIAction { [weak self] _ in self?.shoot() }, for: .primaryActionTriggered)
                NSLayoutConstraint.activate([
                    shutterButton.widthAnchor.constraint(equalToConstant: 64),
                    shutterButton.heightAnchor.constraint(equalToConstant: 64),
                ])
                foot.addArrangedSubview(shutterButton)
            }
        }

        private func showGuidance() {
            guidanceLabel.text = guidance
            guidancePill.isHidden = guidance == nil
        }

        private func showTorch() {
            var configuration = torchOn ? UIButton.Configuration.prominentGlass() : UIButton.Configuration.glass()
            configuration.image = UIImage(systemName: torchOn ? "flashlight.on.fill" : "flashlight.off.fill")
            torchButton.configuration = configuration
            torchButton.accessibilityValue = torchOn ? "On" : "Off"
        }

        private func shoot() {
            guard !capturing, !finished else { return }
            Task {
                guard let photo = try? await capture(options.photo), !finished else { return }
                events.photo(photo)
            }
        }

        // MARK: Bridge

        func setTorch(_ on: Bool) throws(CameraError) {
            guard let camera = AVCaptureDevice.default(for: .video), camera.hasTorch else { throw .failed("This camera has no torch") }
            do {
                try camera.lockForConfiguration()
                camera.torchMode = on ? .on : .off
                camera.unlockForConfiguration()
            } catch {
                throw .failed("The torch couldn't be switched: \(error.localizedDescription)")
            }
            torchOn = on
            showTorch()
        }

        func capture(_ photoOptions: CameraPhotoOptions) async throws(CameraError) -> CameraPhoto {
            guard scanner.isScanning, !finished else { throw .failed("The camera isn't running") }
            guard !capturing else { throw .busy }
            capturing = true
            shutterButton.isEnabled = false
            defer {
                capturing = false
                shutterButton.isEnabled = true
            }
            flash()
            let interface = view.window?.windowScene?.effectiveGeometry.interfaceOrientation ?? .portrait
            let image: UIImage
            do {
                image = try await scanner.capturePhoto()
            } catch {
                throw .failed("The photo couldn't be taken: \(error.localizedDescription)")
            }
            let turns = CameraPhoto.quarterTurns(for: interface, imageSize: image.size)
            guard let photo = await VisionKitCamera.encode(image, options: photoOptions, quarterTurns: turns) else {
                throw .failed("Couldn't save the photo")
            }
            return photo
        }

        private func flash() {
            let cover = UIView(frame: view.bounds)
            cover.backgroundColor = .white
            cover.alpha = 0.6
            view.addSubview(cover)
            UIView.animate(withDuration: 0.25, animations: { cover.alpha = 0 }, completion: { _ in cover.removeFromSuperview() })
        }

        func finish(_ end: CameraScanEnd) {
            guard !finished else { return }
            finished = true
            if torchOn { try? setTorch(false) }
            scanner.stopScanning()
            dismiss(animated: true)
            events.ended(end)
        }

        // MARK: DataScannerViewControllerDelegate

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            report(allItems, force: true)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            report(allItems, force: false)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didRemove removedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            report(allItems, force: true)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            guard let code = code(item) else { return }
            finish(.tapped(code))
        }

        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            finish(.failed("The camera stopped: \(error.localizedDescription)"))
        }

        private func report(_ items: [RecognizedItem], force: Bool) {
            guard !finished else { return }
            let now = Date()
            guard force || now.timeIntervalSince(lastReport) >= Self.updateInterval else { return }
            lastReport = now
            events.codes(items.compactMap(code))
        }

        private func code(_ item: RecognizedItem) -> CameraCode? {
            guard case let .barcode(barcode) = item, let payload = barcode.payloadStringValue else { return nil }
            let size = scanner.view.bounds.size
            guard size.width > 0, size.height > 0 else { return nil }
            let corners = [barcode.bounds.topLeft, barcode.bounds.topRight, barcode.bounds.bottomRight, barcode.bounds.bottomLeft]
            let xs = corners.map(\.x), ys = corners.map(\.y)
            let rect = CGRect(
                x: xs.min()! / size.width, y: ys.min()! / size.height,
                width: (xs.max()! - xs.min()!) / size.width, height: (ys.max()! - ys.min()!) / size.height
            ).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
            return CameraCode(id: barcode.id.uuidString.lowercased(), payload: payload, symbology: barcode.observation.symbology, bounds: rect.isNull ? .zero : rect)
        }
    }
#endif
