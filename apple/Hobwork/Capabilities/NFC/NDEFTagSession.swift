@preconcurrency import CoreNFC
import Foundation

/// Reads or writes one NDEF tag through the system scan sheet.
@MainActor
final class NDEFTagSession: NSObject, NFCTagSession {
    private enum Mode {
        case read
        case write(NFCNDEFMessage)
    }

    private var session: NFCNDEFReaderSession?
    private var mode: Mode = .read
    private var continuation: CheckedContinuation<[NFCRecord], Error>?

    var isAvailable: Bool { NFCNDEFReaderSession.readingAvailable }

    func read() async throws(NFCSessionError) -> [NFCRecord] {
        try await start(.read, prompt: "Hold your iPhone near the tag.")
    }

    func write(url: URL, text: String?) async throws(NFCSessionError) {
        guard let message = Self.message(url: url, text: text) else { throw .failed("Couldn't build the tag's message") }
        _ = try await start(.write(message), prompt: "Hold your iPhone near the tag to write it.")
    }

    nonisolated static func message(url: URL, text: String?) -> NFCNDEFMessage? {
        guard let uri = NFCNDEFPayload.wellKnownTypeURIPayload(url: url) else { return nil }
        var records = [uri]
        if let text, let record = NFCNDEFPayload.wellKnownTypeTextPayload(string: text, locale: Locale(identifier: "en")) {
            records.append(record)
        }
        return NFCNDEFMessage(records: records)
    }

    nonisolated static func record(_ payload: NFCNDEFPayload) -> NFCRecord {
        if let url = payload.wellKnownTypeURIPayload() { return NFCRecord(type: .url, value: url.absoluteString) }
        if payload.typeNameFormat == .nfcWellKnown, payload.type == Data("T".utf8), let text = payload.wellKnownTypeTextPayload().0 {
            return NFCRecord(type: .text, value: text)
        }
        if payload.typeNameFormat == .media, String(decoding: payload.type, as: UTF8.self).hasPrefix("text/"),
           let text = String(data: payload.payload, encoding: .utf8) {
            return NFCRecord(type: .text, value: text)
        }
        return NFCRecord(type: .other, value: payload.payload.base64EncodedString())
    }

    private func start(_ mode: Mode, prompt: String) async throws(NFCSessionError) -> [NFCRecord] {
        guard isAvailable else { throw .unavailable }
        guard session == nil else { throw .failed("Another NFC scan is in progress") }
        self.mode = mode
        let session = NFCNDEFReaderSession(delegate: self, queue: .main, invalidateAfterFirstRead: false)
        session.alertMessage = prompt
        self.session = session
        do {
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                session.begin()
            }
        } catch let error as NFCSessionError {
            throw error
        } catch {
            throw .failed(error.localizedDescription)
        }
    }

    private func finish(_ result: Result<[NFCRecord], NFCSessionError>, message: String? = nil) {
        switch result {
        case .success:
            if let message { session?.alertMessage = message }
            session?.invalidate()
        case let .failure(error):
            if case let .failed(text) = error {
                session?.invalidate(errorMessage: text)
            } else if error == .notWritable || error == .tooSmall {
                session?.invalidate(errorMessage: NFCCapability.callError(error).message)
            }
        }
        session = nil
        continuation?.resume(with: result.mapError { $0 as Error })
        continuation = nil
    }

    private enum TagOutcome: Sendable {
        case read([NFCRecord])
        case written
        case failed(NFCSessionError)
    }

    /// Core NFC's tag objects are not Sendable; they are only used inside this one task.
    private struct TagAccess: @unchecked Sendable {
        let tag: any NFCNDEFTag
        let session: NFCNDEFReaderSession
        var message: NFCNDEFMessage?
    }

    private func handle(_ access: TagAccess) async {
        switch await Self.use(access) {
        case let .read(records): finish(.success(records), message: "Tag read.")
        case .written: finish(.success([]), message: "Tag written.")
        case let .failed(error): finish(.failure(error))
        }
    }

    private nonisolated static func use(_ access: TagAccess) async -> TagOutcome {
        let tag = access.tag
        do {
            try await access.session.connect(to: tag)
            let (status, capacity) = try await tag.queryNDEFStatus()
            guard let message = access.message else {
                guard status != .notSupported else { return .failed(.failed("This tag doesn't hold NDEF data")) }
                return try await .read(tag.readNDEF().records.map(record))
            }
            guard status == .readWrite else { return .failed(.notWritable) }
            guard message.length <= capacity else { return .failed(.tooSmall) }
            try await tag.writeNDEF(message)
            return .written
        } catch let error as NFCReaderError where error.code == .ndefReaderSessionErrorZeroLengthMessage {
            return .read([])
        } catch {
            return .failed(.failed(error.localizedDescription))
        }
    }
}

extension NDEFTagSession: NFCNDEFReaderSessionDelegate {
    nonisolated func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
        let code = (error as? NFCReaderError)?.code
        MainActor.assumeIsolated {
            guard continuation != nil else { return }
            switch code {
            case .readerSessionInvalidationErrorUserCanceled, .readerSessionInvalidationErrorSessionTimeout:
                finish(.failure(.cancelled))
            default:
                finish(.failure(.failed(error.localizedDescription)))
            }
        }
    }

    nonisolated func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {}

    nonisolated func readerSession(_ session: NFCNDEFReaderSession, didDetect tags: [any NFCNDEFTag]) {
        guard let tag = tags.first else { return }
        if tags.count > 1 {
            session.alertMessage = "More than one tag found. Hold your iPhone near only one."
            session.restartPolling()
            return
        }
        let access = TagAccess(tag: tag, session: session, message: nil)
        MainActor.assumeIsolated {
            var access = access
            if case let .write(message) = mode { access.message = message }
            let ready = access
            Task { await self.handle(ready) }
        }
    }
}
