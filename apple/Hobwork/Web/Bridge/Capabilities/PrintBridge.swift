#if os(macOS)
    import AppKit
    import PDFKit
#else
    import UIKit
#endif
import CoreGraphics
import Foundation

/// `print`: prints PDFs a hob made, at an exact paper size, through the system print dialog
/// or straight to a printer the hob printed to before.
@MainActor
final class PrintBridge: BridgeCapability {
    static let maxBytes = 50_000_000

    struct Job {
        var data: Data
        var jobName: String
        /// In points. The PDF's first page when the hob gives none.
        var mediaSize: CGSize
        var printer: String?
        var dialog: Bool
        var output: String
    }

    let name = "print"
    #if os(macOS)
        let methods = ["pdf", "printers", "forgetPrinter"]
    #else
        let methods = ["pdf", "printers", "forgetPrinter", "pickPrinter"]
    #endif
    private let memory: PrinterMemory

    init(memory: PrinterMemory) {
        self.memory = memory
    }

    func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
        let hob = context.origin.permissionKey
        switch method {
        case "printers":
            return .array(memory.printers(hob: hob).map(\.json))
        case "forgetPrinter":
            memory.forget(id: try args.requiredString("id"), hob: hob)
            return .null
        #if os(iOS)
            case "pickPrinter":
                let printer = try await pickPrinter(initial: args.string("printer"), presenter: context.presenter)
                memory.remember(printer, hob: hob)
                return printer.json
        #endif
        default:
            let job = try Self.job(args, hob: context.origin.hob)
            let (printer, paper) = try await print(job, presenter: context.presenter)
            if let printer { memory.remember(printer, hob: hob) }
            return .object([
                "printer": printer?.json ?? .null,
                "paper": paper.map { .object(["width": .number($0.width), "height": .number($0.height)]) } ?? .null,
            ])
        }
    }

    static func job(_ args: JSONValue, hob: String) throws(BridgeError) -> Job {
        guard let data = try args.data("data", limit: maxBytes), !data.isEmpty else { throw .failed("data is required") }
        guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider),
              let page = document.page(at: 1)
        else { throw .failed("data must be a PDF") }
        var size = page.getBoxRect(.mediaBox).size
        if let media = args["mediaSize"], media != .null {
            guard let width = try media.number("width"), let height = try media.number("height"), width > 0, height > 0 else {
                throw .failed("mediaSize needs a width and height in points")
            }
            size = CGSize(width: width, height: height)
        }
        let dialog = try args.bool("dialog") ?? true
        let printer = try args.string("printer")
        if !dialog, printer == nil { throw .failed("Printing without the dialog needs a printer") }
        let output = try args.string("output") ?? "general"
        guard ["general", "grayscale", "photo", "photoGrayscale"].contains(output) else {
            throw .failed("output must be general, grayscale, photo or photoGrayscale")
        }
        return Job(data: data, jobName: try args.string("jobName") ?? hob, mediaSize: size, printer: printer, dialog: dialog, output: output)
    }

    #if os(iOS)
        private func print(_ job: Job, presenter: any BridgePresenter) async throws -> (PrinterMemory.Printer?, CGSize?) {
            let controller = UIPrintInteractionController.shared
            guard controller.printingItem == nil, controller.printPageRenderer == nil else {
                throw BridgeError.failed("Another print is in progress")
            }
            let info = UIPrintInfo.printInfo()
            info.jobName = job.jobName
            info.outputType = switch job.output {
            case "grayscale": .grayscale
            case "photo": .photo
            case "photoGrayscale": .photoGrayscale
            default: .general
            }
            info.orientation = job.mediaSize.width > job.mediaSize.height ? .landscape : .portrait
            if let printer = job.printer { info.printerID = printer }
            let paper = PaperChooser(size: job.mediaSize)
            controller.printInfo = info
            controller.printingItem = job.data
            controller.delegate = paper
            defer {
                controller.printingItem = nil
                controller.delegate = nil
            }
            let completed: Bool = try await withCheckedThrowingContinuation { continuation in
                let done: UIPrintInteractionController.CompletionHandler = { _, completed, error in
                    if let error { continuation.resume(throwing: BridgeError.failed(error.localizedDescription)) } else { continuation.resume(returning: completed) }
                }
                if !job.dialog, let id = job.printer, let url = URL(string: id) {
                    controller.print(to: UIPrinter(url: url), completionHandler: done)
                } else if let view = presenter.bridgeView, view.traitCollection.userInterfaceIdiom == .pad {
                    controller.present(from: Self.anchor(in: view), in: view, animated: true, completionHandler: done)
                } else {
                    controller.present(animated: true, completionHandler: done)
                }
            }
            guard completed else { throw BridgeError.cancelled("Printing was cancelled") }
            let printer = await controller.printInfo?.printerID.flatMap(URL.init(string:)).asyncMap(Self.printer(at:))
            return (printer, paper.chosen)
        }

        private func pickPrinter(initial: String?, presenter: any BridgePresenter) async throws -> PrinterMemory.Printer {
            let picker = UIPrinterPickerController(initiallySelectedPrinter: initial.flatMap(URL.init(string:)).map(UIPrinter.init(url:)))
            let selected: Bool = await withCheckedContinuation { continuation in
                let done: UIPrinterPickerController.CompletionHandler = { _, selected, _ in continuation.resume(returning: selected) }
                if let view = presenter.bridgeView, view.traitCollection.userInterfaceIdiom == .pad {
                    picker.present(from: Self.anchor(in: view), in: view, animated: true, completionHandler: done)
                } else {
                    picker.present(animated: true, completionHandler: done)
                }
            }
            guard selected, let printer = picker.selectedPrinter else { throw BridgeError.cancelled("No printer was chosen") }
            return PrinterMemory.Printer(id: printer.url.absoluteString, name: printer.displayName, lastUsedAt: Date())
        }

        /// A printer made from a URL has no name until the app contacts it.
        private static func printer(at url: URL) async -> PrinterMemory.Printer {
            let printer = UIPrinter(url: url)
            _ = await withCheckedContinuation { continuation in
                printer.contactPrinter { continuation.resume(returning: $0) }
            }
            let name = printer.displayName.isEmpty ? (url.host() ?? url.absoluteString) : printer.displayName
            return PrinterMemory.Printer(id: url.absoluteString, name: name, lastUsedAt: Date())
        }

        /// Popovers on iPad point at the bottom middle of the web view: the page's button is
        /// inside a frame whose position the app does not know.
        static func anchor(in view: UIView) -> CGRect {
            CGRect(x: view.bounds.midX, y: view.bounds.maxY - 1, width: 1, height: 1)
        }

        /// Picks the printer's paper closest to the job's size.
        private final class PaperChooser: NSObject, UIPrintInteractionControllerDelegate {
            let size: CGSize
            var chosen: CGSize?

            init(size: CGSize) {
                self.size = size
            }

            func printInteractionController(_ controller: UIPrintInteractionController, choosePaper paperList: [UIPrintPaper]) -> UIPrintPaper {
                let paper = UIPrintPaper.bestPaper(forPageSize: size, withPapersFrom: paperList)
                chosen = paper.paperSize
                return paper
            }
        }
    #else
        private func print(_ job: Job, presenter: any BridgePresenter) async throws -> (PrinterMemory.Printer?, CGSize?) {
            guard let document = PDFDocument(data: job.data) else { throw BridgeError.failed("data must be a PDF") }
            let info = NSPrintInfo()
            info.paperSize = job.mediaSize
            info.orientation = job.mediaSize.width > job.mediaSize.height ? .landscape : .portrait
            info.topMargin = 0
            info.bottomMargin = 0
            info.leftMargin = 0
            info.rightMargin = 0
            if let name = job.printer {
                guard let printer = NSPrinter(name: name) else { throw BridgeError.unavailable("The printer \(name) is not set up on this Mac") }
                info.printer = printer
            }
            guard let operation = document.printOperation(for: info, scalingMode: .pageScaleNone, autoRotate: false) else {
                throw BridgeError.failed("This PDF can't be printed")
            }
            operation.jobTitle = job.jobName
            operation.showsPrintPanel = job.dialog
            operation.showsProgressPanel = job.dialog
            let completed: Bool
            if let window = presenter.bridgeWindow {
                completed = await PrintSheet().run(operation, for: window)
            } else {
                completed = operation.run()
            }
            guard completed else { throw BridgeError.cancelled("Printing was cancelled") }
            let used = operation.printInfo
            let printer = PrinterMemory.Printer(id: used.printer.name, name: used.printer.name, lastUsedAt: Date())
            return (printer, used.paperSize)
        }

        /// The print panel as a sheet on the window, which calls back through a selector.
        @MainActor private final class PrintSheet: NSObject {
            private var continuation: CheckedContinuation<Bool, Never>?

            func run(_ operation: NSPrintOperation, for window: NSWindow) async -> Bool {
                await withCheckedContinuation { continuation in
                    self.continuation = continuation
                    operation.runModal(
                        for: window, delegate: self,
                        didRun: #selector(printOperationDidRun(_:success:contextInfo:)), contextInfo: nil
                    )
                }
            }

            @objc func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
                continuation?.resume(returning: success)
                continuation = nil
            }
        }
    #endif
}

extension Optional {
    func asyncMap<T>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
        guard let self else { return nil }
        return try await transform(self)
    }
}
