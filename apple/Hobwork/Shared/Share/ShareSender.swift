import Foundation

/// Sends HTTP requests for the share sheet; tests replace it.
protocol ShareTransport: Sendable {
    /// The answer's body and status. Throws when no answer arrived.
    func send(_ request: URLRequest, body: Data?) async throws -> (Data, Int)
}

struct URLSessionShareTransport: ShareTransport {
    var session: URLSession = .shared

    func send(_ request: URLRequest, body: Data?) async throws -> (Data, Int) {
        let (data, response) = if let body {
            try await session.upload(for: request, from: body)
        } else {
            try await session.data(for: request)
        }
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

struct ShareProgress: Equatable, Sendable {
    enum Stage: Equatable, Sendable {
        /// Uploading the file at this index of the payload's files.
        case uploading(file: Int)
        /// Files are in; the hob's route runs.
        case sending
    }

    var stage: Stage
    var sent: Int
    var total: Int
}

struct ShareError: Error, Equatable, LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// Uploads shared files in parts into the target's upload folder, then runs the target's route:
/// the device endpoints `POST /api/devices/uploads`, `PUT|GET|DELETE
/// /api/devices/uploads/<hob>/<target>/<id>` and `POST /api/devices/share`.
///
/// Parts are read from the file one at a time (8 MB, as the host says), so a 200 MB model needs
/// one part in memory, well inside a share extension's memory limit.
struct ShareSender: Sendable {
    static let retries = 3

    let api: HostAPI
    var transport: any ShareTransport = URLSessionShareTransport()

    struct UploadStatus: Decodable, Equatable {
        var id: String
        var path: String
        var size: Int
        var received: Int
        var chunkBytes: Int
    }

    struct StoredFile: Equatable, Sendable {
        var path: String
        var item: SharedFileItem
    }

    /// Runs the whole share and returns what the hob says.
    func send(hob: String, target: String, payload: SharePayload, progress: @Sendable (ShareProgress) -> Void) async throws -> String? {
        let total = payload.files.reduce(0) { $0 + $1.size }
        var done = 0
        var stored: [StoredFile] = []
        for (index, item) in payload.files.enumerated() {
            let before = done
            let path = try await upload(item, hob: hob, target: target) { sent in
                progress(ShareProgress(stage: .uploading(file: index), sent: before + sent, total: total))
            }
            done += item.size
            stored.append(StoredFile(path: path, item: item))
        }
        progress(ShareProgress(stage: .sending, sent: total, total: total))
        return try await share(hob: hob, target: target, payload: payload, files: stored)
    }

    /// Uploads one file and returns its path on the host.
    func upload(_ item: SharedFileItem, hob: String, target: String, progress: (Int) -> Void) async throws -> String {
        var body: [String: JSONValue] = [
            "hob": .string(hob), "target": .string(target), "name": .string(item.name), "size": .number(Double(item.size)),
        ]
        if let type = item.contentType { body["type"] = .string(type) }
        var status: UploadStatus = try await decode(api.request(method: "POST", path: "api/devices/uploads", body: JSONValue.object(body)), body: nil)
        let handle = try FileHandle(forReadingFrom: item.file)
        defer { try? handle.close() }
        var failures = 0
        // Until the host stores the file. An empty file takes one empty part.
        while true {
            if Task.isCancelled { throw abandon(hob: hob, target: target, id: status.id) }
            try handle.seek(toOffset: UInt64(status.received))
            let part = try handle.read(upToCount: min(status.chunkBytes, status.size - status.received)) ?? Data()
            guard !part.isEmpty || status.received == status.size else { throw ShareError(message: "\(item.name) changed while it was being sent.") }
            let last = status.received + part.count == status.size
            do {
                let (data, code) = try await transport.send(partRequest(hob: hob, target: target, id: status.id, offset: status.received), body: part)
                if code == 201 {
                    progress(status.size)
                    return status.path
                }
                if code == 200 {
                    status = try JSONDecoder().decode(UploadStatus.self, from: data)
                    failures = 0
                    progress(status.received)
                    continue
                }
                // 409: the host expects another offset. Anything else ends the upload.
                if code != 409 { throw Self.failure(data, code: code) }
                failures += 1
            } catch let error as ShareError {
                throw error
            } catch {
                if Task.isCancelled { throw abandon(hob: hob, target: target, id: status.id) }
                failures += 1
            }
            if failures > Self.retries { throw ShareError(message: "Couldn't send \(item.name). Check your connection and try again.") }
            // Ask where the upload stands. The host forgets an upload once it stored the file,
            // so after a last part whose answer was lost, the file is in.
            let (data, code) = try await answer(statusRequest(hob: hob, target: target, id: status.id))
            if code == 404, last { return status.path }
            guard code == 200, let current = try? JSONDecoder().decode(UploadStatus.self, from: data) else { throw Self.failure(data, code: code) }
            status = current
        }
    }

    func share(hob: String, target: String, payload: SharePayload, files: [StoredFile]) async throws -> String? {
        var body: [String: JSONValue] = [
            "hob": .string(hob), "target": .string(target),
            "files": .array(files.map { file in
                .object([
                    "path": .string(file.path), "name": .string(file.item.name), "size": .number(Double(file.item.size)),
                    "contentType": file.item.contentType.map(JSONValue.string) ?? .null,
                ])
            }),
        ]
        if let url = payload.url { body["url"] = .string(url.absoluteString) }
        if let text = payload.text { body["text"] = .string(text) }
        var request = api.request(method: "POST", path: "api/devices/share", body: JSONValue.object(body))
        // The hob's handler may take a while.
        request.timeoutInterval = 60
        let answer: JSONValue = try await decode(request, body: nil)
        guard answer["ok"] == .bool(true) else {
            throw ShareError(message: answer["error"]?["message"]?.stringValue ?? "The hob couldn't take it.")
        }
        return answer["say"]?.stringValue
    }

    /// Tells the host to drop the upload, outside the cancelled task, whose requests would fail.
    private func abandon(hob: String, target: String, id: String) -> CancellationError {
        Task { await cancel(hob: hob, target: target, id: id) }
        return CancellationError()
    }

    func cancel(hob: String, target: String, id: String) async {
        var request = statusRequest(hob: hob, target: target, id: id)
        request.httpMethod = "DELETE"
        _ = try? await transport.send(request, body: nil)
    }

    func partRequest(hob: String, target: String, id: String, offset: Int) -> URLRequest {
        var request = api.request(method: "PUT", path: "api/devices/uploads/\(hob)/\(target)/\(id)")
        request.url = request.url?.appending(queryItems: [URLQueryItem(name: "offset", value: String(offset))])
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        return request
    }

    func statusRequest(hob: String, target: String, id: String) -> URLRequest {
        api.request(method: "GET", path: "api/devices/uploads/\(hob)/\(target)/\(id)")
    }

    private func answer(_ request: URLRequest, body: Data? = nil) async throws -> (Data, Int) {
        do {
            return try await transport.send(request, body: body)
        } catch {
            throw ShareError(message: "Couldn't reach your Hobwork host: \(error.localizedDescription)")
        }
    }

    private func decode<T: Decodable>(_ request: URLRequest, body: Data?) async throws -> T {
        let (data, code) = try await answer(request, body: body)
        guard (200 ..< 300).contains(code) else { throw Self.failure(data, code: code) }
        guard let value = try? JSONDecoder().decode(T.self, from: data) else {
            throw ShareError(message: "Your Hobwork host sent an answer this app does not understand.")
        }
        return value
    }

    private static func failure(_ data: Data, code: Int) -> ShareError {
        if code == 401 { return ShareError(message: "This device is no longer connected to your Hobwork host. Open Hobwork to connect it again.") }
        let message = (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.stringValue
        return ShareError(message: message ?? "Your Hobwork host answered with HTTP \(code).")
    }
}
