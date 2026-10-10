@preconcurrency import CoreNFC
import Foundation

/// Reads and writes tags through the system scan sheet. A tag reader session (rather than an
/// NDEF one) exposes each tag's hardware ID: NTAG21x tags are MiFare Ultralight, others ISO
/// 15693 or ISO 7816.
@MainActor
final class CoreNFCTagSession: NSObject, NFCTagSession {
    private enum Mode {
        case read(CheckedContinuation<NFCTagRead, Error>)
        case write(NFCNDEFMessage, CheckedContinuation<NFCTagRead, Error>)
        case scan(keepOpen: Bool, onTag: @MainActor (NFCTagRead) -> Void, onEnd: @MainActor (NFCScanEnd) -> Void)
    }

    /// A tag left on the reader is found again after each restart; it counts once until
    /// another tag comes or this much time passes.
    private static let repeatWindow: TimeInterval = 3

    private var session: NFCTagReaderSession?
    private var mode: Mode?
    private var sheet = NFCSheet()
    private var lastTag: (uid: String, at: Date)?
    private var stopMessage: String?

    var isAvailable: Bool { NFCTagReaderSession.readingAvailable }

    func read(sheet: NFCSheet) async throws(NFCSessionError) -> NFCTagRead {
        try await oneTag(sheet: sheet, prompt: "Hold your iPhone near the tag.") { .read($0) }
    }

    func write(url: URL, text: String?, sheet: NFCSheet) async throws(NFCSessionError) -> NFCTagRead {
        guard let message = Self.message(url: url, text: text) else { throw .failed("Couldn't build the tag's message") }
        return try await oneTag(sheet: sheet, prompt: "Hold your iPhone near the tag to write it.") { .write(message, $0) }
    }

    func startScan(
        sheet: NFCSheet,
        keepOpen: Bool,
        onTag: @escaping @MainActor (NFCTagRead) -> Void,
        onEnd: @escaping @MainActor (NFCScanEnd) -> Void
    ) throws(NFCSessionError) {
        let session = try makeSession(sheet: sheet, prompt: keepOpen ? "Hold your iPhone near a tag. Keep going with the next one." : "Hold your iPhone near the tag.")
        mode = .scan(keepOpen: keepOpen, onTag: onTag, onEnd: onEnd)
        session.begin()
    }

    func updateScan(alertMessage: String) {
        guard case .scan = mode else { return }
        session?.alertMessage = alertMessage
    }

    func stopScan(message: String?) {
        guard case .scan = mode, let session else { return }
        stopMessage = message
        end(.stopped, session: session)
    }

    private func oneTag(
        sheet: NFCSheet,
        prompt: String,
        mode make: (CheckedContinuation<NFCTagRead, Error>) -> Mode
    ) async throws(NFCSessionError) -> NFCTagRead {
        let session = try makeSession(sheet: sheet, prompt: prompt)
        do {
            return try await withCheckedThrowingContinuation { continuation in
                self.mode = make(continuation)
                session.begin()
            }
        } catch let error as NFCSessionError {
            throw error
        } catch {
            throw .failed(error.localizedDescription)
        }
    }

    private func makeSession(sheet: NFCSheet, prompt: String) throws(NFCSessionError) -> NFCTagReaderSession {
        guard isAvailable else { throw .unavailable }
        guard session == nil else { throw .busy }
        guard let session = NFCTagReaderSession(pollingOption: [.iso14443, .iso15693], delegate: self, queue: .main) else {
            throw .unavailable
        }
        session.alertMessage = sheet.alertMessage ?? prompt
        self.session = session
        self.sheet = sheet
        lastTag = nil
        stopMessage = nil
        return session
    }

    /// Ends a one-tag read or write with its result.
    private func finish(_ result: Result<NFCTagRead, NFCSessionError>, success: String) {
        guard let session else { return }
        switch result {
        case .success:
            session.alertMessage = sheet.successMessage ?? success
            session.invalidate()
        case let .failure(error):
            switch error {
            case .cancelled, .timeout, .unavailable, .busy: session.invalidate()
            default: session.invalidate(errorMessage: NFCCapability.callError(error).message)
            }
        }
        let mode = mode
        clear()
        switch mode {
        case let .read(continuation)?, let .write(_, continuation)?:
            continuation.resume(with: result.mapError { $0 as Error })
        default:
            break
        }
    }

    private func end(_ reason: NFCScanEnd, session: NFCTagReaderSession) {
        guard case let .scan(_, _, onEnd)? = mode else { return }
        switch reason {
        case .stopped:
            if let message = stopMessage ?? sheet.successMessage { session.alertMessage = message }
            session.invalidate()
        case let .failed(message):
            session.invalidate(errorMessage: message)
        case .timeout, .cancelled:
            break
        }
        clear()
        onEnd(reason)
    }

    private func clear() {
        session = nil
        mode = nil
        lastTag = nil
    }

    // MARK: Tags

    /// Core NFC's tag objects are not Sendable; they are only used inside one task.
    private struct TagAccess: @unchecked Sendable {
        let tag: NFCTag
        let session: NFCTagReaderSession
        var message: NFCNDEFMessage?
    }

    private enum TagOutcome: Sendable {
        case done(NFCTagRead)
        case failed(NFCSessionError)
    }

    private func detected(_ access: TagAccess) async {
        guard access.session === session else { return }
        let outcome = await Self.use(access)
        guard access.session === session, let mode else { return }
        switch mode {
        case .read:
            switch outcome {
            case let .done(read): finish(.success(read), success: "Tag read.")
            case let .failed(error): finish(.failure(error), success: "")
            }
        case .write:
            switch outcome {
            case let .done(read): finish(.success(read), success: "Tag written.")
            case let .failed(error): finish(.failure(error), success: "")
            }
        case let .scan(keepOpen, onTag, _):
            switch outcome {
            case let .done(read):
                let now = Date()
                if let uid = read.uid, let last = lastTag, last.uid == uid, now.timeIntervalSince(last.at) < Self.repeatWindow {
                    lastTag = (uid, now)
                } else {
                    if let uid = read.uid { lastTag = (uid, now) }
                    onTag(read)
                    if !keepOpen {
                        end(.stopped, session: access.session)
                        return
                    }
                }
            case let .failed(error):
                // One unreadable tag does not end a scan chain.
                access.session.alertMessage = NFCCapability.callError(error).message
            }
            try? await Task.sleep(for: .milliseconds(400))
            if access.session === session { access.session.restartPolling() }
        }
    }

    private nonisolated static func use(_ access: TagAccess) async -> TagOutcome {
        let tag = access.tag
        do {
            try await access.session.connect(to: tag)
            let uid = identifier(of: tag)
            let ndef = ndefTag(tag)
            let (status, capacity) = try await ndef.queryNDEFStatus()
            guard let message = access.message else {
                guard status != .notSupported else { return .done(NFCTagRead(records: [], uid: uid)) }
                return try await .done(NFCTagRead(records: readRecords(ndef), uid: uid))
            }
            guard status == .readWrite else { return .failed(.notWritable) }
            guard message.length <= capacity else { return .failed(.tooSmall) }
            try await ndef.writeNDEF(message)
            let back = try await ndef.readNDEF()
            guard sameMessage(back, message) else { return .failed(.verifyFailed) }
            return .done(NFCTagRead(records: back.records.map(record), uid: uid))
        } catch {
            return .failed(.failed(error.localizedDescription))
        }
    }

    private nonisolated static func readRecords(_ tag: any NFCNDEFTag) async throws -> [NFCRecord] {
        do {
            return try await tag.readNDEF().records.map(record)
        } catch let error as NFCReaderError where error.code == .ndefReaderSessionErrorZeroLengthMessage {
            return []
        }
    }

    private nonisolated static func ndefTag(_ tag: NFCTag) -> any NFCNDEFTag {
        switch tag {
        case let .miFare(tag): tag
        case let .iso15693(tag): tag
        case let .iso7816(tag): tag
        case let .feliCa(tag): tag
        @unknown default: fatalError("Unknown NFC tag type")
        }
    }

    private nonisolated static func identifier(of tag: NFCTag) -> String? {
        let data: Data = switch tag {
        case let .miFare(tag): tag.identifier
        case let .iso15693(tag): tag.identifier
        case let .iso7816(tag): tag.identifier
        case let .feliCa(tag): tag.currentIDm
        @unknown default: Data()
        }
        return data.isEmpty ? nil : hex(data)
    }

    nonisolated static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Messages

    nonisolated static func message(url: URL, text: String?) -> NFCNDEFMessage? {
        guard let uri = NFCNDEFPayload.wellKnownTypeURIPayload(url: url) else { return nil }
        var records = [uri]
        if let text, let record = NFCNDEFPayload.wellKnownTypeTextPayload(string: text, locale: Locale(identifier: "en")) {
            records.append(record)
        }
        return NFCNDEFMessage(records: records)
    }

    /// Whether a tag read back what was written, record by record.
    nonisolated static func sameMessage(_ lhs: NFCNDEFMessage, _ rhs: NFCNDEFMessage) -> Bool {
        lhs.records.count == rhs.records.count && zip(lhs.records, rhs.records).allSatisfy { a, b in
            a.typeNameFormat == b.typeNameFormat && a.type == b.type && a.payload == b.payload
        }
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
}

extension CoreNFCTagSession: NFCTagReaderSessionDelegate {
    nonisolated func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    nonisolated func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        let code = (error as? NFCReaderError)?.code
        let text = error.localizedDescription
        MainActor.assumeIsolated {
            guard session === self.session else { return }
            switch mode {
            case .read?, .write?:
                switch code {
                case .readerSessionInvalidationErrorUserCanceled: finish(.failure(.cancelled), success: "")
                case .readerSessionInvalidationErrorSessionTimeout: finish(.failure(.timeout), success: "")
                default: finish(.failure(.failed(text)), success: "")
                }
            case .scan?:
                switch code {
                case .readerSessionInvalidationErrorUserCanceled: end(.cancelled, session: session)
                case .readerSessionInvalidationErrorSessionTimeout: end(.timeout, session: session)
                default: end(.failed(text), session: session)
                }
            case nil:
                clear()
            }
        }
    }

    nonisolated func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard let tag = tags.first else { return }
        if tags.count > 1 {
            session.alertMessage = "More than one tag found. Hold your iPhone near only one."
            session.restartPolling()
            return
        }
        let access = TagAccess(tag: tag, session: session, message: nil)
        MainActor.assumeIsolated {
            var access = access
            if case let .write(message, _)? = mode { access.message = message }
            let ready = access
            Task { await self.detected(ready) }
        }
    }
}
