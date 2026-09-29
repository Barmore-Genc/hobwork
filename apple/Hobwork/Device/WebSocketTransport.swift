import Foundation

protocol DeviceSocket: AnyObject, Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func cancel()
}

enum DeviceSocketError: Error, Equatable {
    /// The device was removed: 401 before the upgrade, or close code 4001.
    case unauthorized
    /// Another connection of this device took over (close code 4000).
    case replaced
    /// The device's owner may no longer sign in to the host (close code 4004). The
    /// token works again once they are allowed back.
    case ownerNotAllowed
    case closed
    case timedOut

    /// The host refuses the upgrade with 401 for a removed device and 403 when its
    /// owner may not sign in.
    init?(upgradeStatus: Int) {
        switch upgradeStatus {
        case 401: self = .unauthorized
        case 403: self = .ownerNotAllowed
        default: return nil
        }
    }

    /// Close codes from the host with a meaning beyond "reconnect".
    init?(closeCode: Int) {
        switch closeCode {
        case 4000: self = .replaced
        case 4001: self = .unauthorized
        case 4004: self = .ownerNotAllowed
        default: return nil
        }
    }
}

final class URLSessionDeviceSocket: DeviceSocket {
    private let task: URLSessionWebSocketTask

    init(request: URLRequest, session: URLSession = .shared) {
        task = session.webSocketTask(with: request)
        task.resume()
    }

    func send(_ text: String) async throws {
        do {
            try await task.send(.string(text))
        } catch {
            throw mapped(error)
        }
    }

    func receive() async throws -> String {
        do {
            switch try await task.receive() {
            case let .string(text): return text
            case let .data(data): return String(decoding: data, as: UTF8.self)
            @unknown default: throw DeviceSocketError.closed
            }
        } catch {
            throw mapped(error)
        }
    }

    func cancel() {
        task.cancel(with: .normalClosure, reason: nil)
    }

    private func mapped(_ error: Error) -> Error {
        if let response = task.response as? HTTPURLResponse, let error = DeviceSocketError(upgradeStatus: response.statusCode) {
            return error
        }
        return DeviceSocketError(closeCode: task.closeCode.rawValue) ?? error
    }
}
