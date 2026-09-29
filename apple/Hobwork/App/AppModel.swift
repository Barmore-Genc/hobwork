import FamilyControls
import Foundation
import HealthKit
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
    private(set) var capabilities = CapabilityStatus()
    /// Shown on the pairing screen, for example after the host removed this device.
    var notice: String?
    /// Shown over the web view after scanning a tag or opening a tag link.
    var nfcNotice: String?

    @ObservationIgnored let web = WebController()
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored let alarms = AlarmKitScheduler()
    @ObservationIgnored let nfc = NDEFTagSession()
    @ObservationIgnored let healthStore = HKHealthStore()
    @ObservationIgnored private(set) lazy var health = HealthDelivery(store: healthStore) { [weak self] event in
        await self?.send(event)
    }
    @ObservationIgnored private let events = StoredEventQueue()
    @ObservationIgnored private var pushToken: String?

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
        EventSender.model = self
        if let stored = StoredPairing.load() {
            activate(Pairing(host: stored.host, credentials: stored.credentials))
        }
        health.start()
    }

    var api: HostAPI? {
        pairing.map { HostAPI(host: $0.host, token: $0.credentials.token) }
    }

    func completePairing(host: URL, credentials: DeviceCredentials) throws {
        try StoredPairing.save(host: host, credentials: credentials)
        notice = nil
        activate(Pairing(host: host, credentials: credentials))
    }

    /// Removes the device from the host and forgets the host: the device token, the web
    /// view's session and queued events. Local state goes even when the host can't be reached.
    func signOut(notice: String? = nil) async {
        if notice == nil { try? await api?.removeDevice() }
        connection?.stop()
        connection = nil
        StoredPairing.remove()
        events.removeAll()
        pairing = nil
        self.notice = notice
        await web.reset()
    }

    func sceneBecameActive() {
        guard pairing != nil else { return }
        if scanWhenActive {
            scanWhenActive = false
            Task { await scanTag() }
        }
        if connection?.state != .connected { connection?.reconnect() }
        web.checkSession()
        Task { await refreshCapabilities() }
    }

    func sceneEnteredBackground() {
        connection?.stop()
    }

    /// Checks what is set up and allowed again, and reconnects so the host sees the change
    /// in `hello`.
    func refreshCapabilities() async {
        let status = await CapabilityStatus.current()
        guard status != capabilities else { return }
        capabilities = status
        if connection?.state == .connected { connection?.reconnect() }
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

    /// Over the socket when connected, otherwise straight to the host, queued when that fails.
    func send(_ event: DeviceEvent) async {
        if let connection, connection.state == .connected {
            connection.send(event)
            return
        }
        // iOS gives work in the background only a few seconds, too short to open a socket.
        guard let api else { return }
        do {
            try await api.send(event)
        } catch HostError.unauthorized {
            await revoked()
        } catch {
            events.append(event)
        }
    }

    // MARK: Capabilities

    func requestAlarms() async {
        _ = await alarms.requestAuthorization()
        await refreshCapabilities()
    }

    func requestScreenTime() async throws {
        try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
        await refreshCapabilities()
    }

    func shareHealth(_ types: Set<HealthType>) async throws {
        try await health.share(types)
        await refreshCapabilities()
    }

    /// The "Scan Tag" button and the Scan NFC Tag action: reads a tag and sends its link to the
    /// host, which runs the project that wrote it or the triggers for that link.
    func scanTag() async {
        guard pairing != nil else { return }
        do {
            let records = try await nfc.read()
            guard let event = NFCTagLink.event(records: records, host: pairing?.host) else {
                nfcNotice = "This tag has no link, so there is nothing to send to your projects."
                return
            }
            await send(event)
            nfcNotice = "Tag scanned."
        } catch .cancelled {
            return
        } catch {
            nfcNotice = NFCCapability.callError(error).message
        }
    }

    /// Scans once the app is on screen: Core NFC only starts a scan for the active app, and the
    /// Scan NFC Tag action can run while the app is still opening.
    func scanTagWhenActive() async {
        if UIApplication.shared.applicationState == .active {
            await scanTag()
        } else {
            scanWhenActive = true
        }
    }

    @ObservationIgnored private var scanWhenActive = false

    /// `hobwork://nfc/<tag>` and universal links to `<host>/nfc/<tag>`.
    func open(_ url: URL) {
        guard pairing != nil, let tag = NFCTagLink.tag(from: url, host: pairing?.host) else { return }
        Task {
            await send(NFCTagLink.event(tag: tag))
            nfcNotice = "Tag scanned."
        }
    }

    private func activate(_ pairing: Pairing) {
        self.pairing = pairing
        let api = HostAPI(host: pairing.host, token: pairing.credentials.token)
        let runner = CommandRunner(log: FileCommandLog())
        runner.register(notifier, for: Notifier.capability)
        runner.register(NFCCapability(session: nfc, host: { [weak self] in self?.pairing?.host }), for: NFCCapability.capability)
        BackgroundCapabilities.register(on: runner, alarms: alarms, health: HealthKitReader(store: healthStore))
        self.runner = runner
        let connection = DeviceConnection(
            request: api.webSocketRequest,
            hello: { [weak self] in self?.hello ?? Hello(appVersion: Self.appVersion, platform: "ios", capabilities: []) },
            queue: events,
            runner: runner
        )
        connection.onUnauthorized = { [weak self] in Task { await self?.revoked() } }
        self.connection = connection
        web.configure(
            host: pairing.host,
            requestWebSession: { returnTo in try await api.webSession(returnTo: returnTo) },
            onUnauthorized: { [weak self] in Task { await self?.revoked() } }
        )
        Task {
            capabilities = await CapabilityStatus.current()
            connection.start()
            await notifier.requestAuthorization()
            await refreshCapabilities()
        }
    }

    @ObservationIgnored private var runner: CommandRunner?

    private var hello: Hello {
        Hello(
            appVersion: Self.appVersion,
            platform: "ios",
            capabilities: capabilities.reported,
            push: pushToken.map { PushRegistration(token: $0, environment: Self.pushEnvironment) }
        )
    }

    private func revoked() async {
        guard let host = pairing?.host.host() else { return }
        await signOut(notice: "This device was removed from \(host). Connect again to keep using it.")
    }

    private func handle(_ response: Notifier.Response) async {
        if let path = response.path { web.open(link: path) }
        if let command = response.command { await run(command) }
        if let event = response.event { await send(event) }
    }

    /// A tapped command push. The extension already ran background commands; the command
    /// log answers those again, which is harmless since the host keeps the first result.
    private func run(_ command: DeviceCommand) async {
        guard let runner, let api, let outcome = await runner.run(command) else { return }
        try? await api.send(DeviceCallResult(id: command.id, outcome: outcome.result))
    }
}
