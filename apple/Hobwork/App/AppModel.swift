import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class AppModel {
    struct Pairing: Equatable {
        var host: URL
        var credentials: DeviceCredentials
    }

    private(set) var pairing: Pairing?
    private(set) var connection: DeviceConnection?
    /// Shown on the pairing screen, for example after the host removed this device.
    var notice: String?

    @ObservationIgnored let web = WebController()
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored private let events = StoredEventQueue()
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var pushToken: String?

    private static let hostKey = "host"

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }

    static var pushEnvironment: PushRegistration.Environment {
        #if DEBUG
            .sandbox
        #else
            .production
        #endif
    }

    init() {
        notifier.onResponse = { [weak self] response in await self?.handle(response) }
        if let host = defaults.url(forKey: Self.hostKey), let credentials = Keychain.load(for: host) {
            activate(Pairing(host: host, credentials: credentials))
        }
    }

    var api: HostAPI? {
        pairing.map { HostAPI(host: $0.host, token: $0.credentials.token) }
    }

    func completePairing(host: URL, credentials: DeviceCredentials) throws {
        try Keychain.save(credentials, for: host)
        defaults.set(host, forKey: Self.hostKey)
        notice = nil
        activate(Pairing(host: host, credentials: credentials))
    }

    /// Removes the device from the host and forgets the host: the device token, the web
    /// view's session and queued events. Local state goes even when the host can't be reached.
    func signOut(notice: String? = nil) async {
        if notice == nil { try? await api?.removeDevice() }
        connection?.stop()
        connection = nil
        if let host = pairing?.host { Keychain.delete(for: host) }
        defaults.removeObject(forKey: Self.hostKey)
        events.removeAll()
        pairing = nil
        self.notice = notice
        await web.reset()
    }

    func sceneBecameActive() {
        guard pairing != nil else { return }
        if connection?.state != .connected { connection?.reconnect() }
        web.checkSession()
    }

    func sceneEnteredBackground() {
        connection?.stop()
    }

    func didRegisterForPush(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        guard hex != pushToken else { return }
        pushToken = hex
        guard let api else { return }
        let push = PushRegistration(token: hex, environment: Self.pushEnvironment)
        Task {
            do {
                try await api.updatePush(push)
            } catch HostError.unauthorized {
                await revoked()
            } catch {
                // The next hello carries the token.
            }
        }
    }

    private func activate(_ pairing: Pairing) {
        self.pairing = pairing
        let api = HostAPI(host: pairing.host, token: pairing.credentials.token)
        let connection = DeviceConnection(
            request: api.webSocketRequest,
            hello: { [weak self] in self?.hello ?? Hello(appVersion: Self.appVersion, platform: "ios", capabilities: []) },
            queue: events
        )
        connection.register(notifier, for: Notifier.capability)
        connection.onUnauthorized = { [weak self] in Task { await self?.revoked() } }
        self.connection = connection
        connection.start()
        web.configure(
            host: pairing.host,
            requestWebSession: { returnTo in try await api.webSession(returnTo: returnTo) },
            onUnauthorized: { [weak self] in Task { await self?.revoked() } }
        )
        Task { await notifier.requestAuthorization() }
    }

    private var hello: Hello {
        Hello(
            appVersion: Self.appVersion,
            platform: "ios",
            capabilities: [Notifier.capability],
            push: pushToken.map { PushRegistration(token: $0, environment: Self.pushEnvironment) }
        )
    }

    private func revoked() async {
        guard let host = pairing?.host.host() else { return }
        await signOut(notice: "This device was removed from \(host). Connect again to keep using it.")
    }

    private func handle(_ response: Notifier.Response) async {
        if let path = response.path { web.open(link: path) }
        guard let event = response.event else { return }
        if let connection, connection.state == .connected {
            connection.send(event)
            return
        }
        // iOS gives an action that does not open the app only a few seconds in the
        // background, too short to open a socket.
        guard let api else { return }
        do {
            try await api.send(event)
        } catch HostError.unauthorized {
            await revoked()
        } catch {
            events.append(event)
        }
    }
}
