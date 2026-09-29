import Foundation

/// Sends events from code that runs without the app model, such as the Focus filter, which
/// iOS can run before the app finished launching.
@MainActor
enum EventSender {
    static weak var model: AppModel?

    static func send(_ event: DeviceEvent) async {
        if let model {
            await model.send(event)
            return
        }
        guard let pairing = StoredPairing.load() else { return }
        do {
            try await HostAPI(host: pairing.host, token: pairing.credentials.token).send(event)
        } catch {
            StoredEventQueue().append(event)
        }
    }
}
