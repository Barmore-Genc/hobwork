#if os(iOS)
    import AlarmKit
    import FamilyControls
    import HealthKit
    import UIKit
#endif
import Foundation
import Observation

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
    #if os(iOS)
        /// Shown over the web view after scanning a tag or opening a tag link.
        var nfcNotice: String?
        var sheet: Sheet?
        /// Shown on the alarms screen when a tapped alarms command failed.
        var alarmProblem: AlarmFollowUp.Problem?

        enum Sheet: String, Identifiable {
            case settings, alarms

            var id: String { rawValue }
        }
    #endif

    @ObservationIgnored let web = WebController()
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored let push = PushCoordinator(
        relay: RelayClient(asserter: SystemAppAttest()),
        attester: SystemAppAttest()
    )
    #if os(iOS)
        @ObservationIgnored let alarms = AlarmKitScheduler()
        @ObservationIgnored let nfc = CoreNFCTagSession()
        @ObservationIgnored private(set) lazy var alarmEvents = AlarmEventReporter { [weak self] report in
            await self?.deliver(report)
        }
        @ObservationIgnored let liveActivitySystem = ActivityKitSystem()
        @ObservationIgnored private(set) lazy var liveActivities = LiveActivities(system: liveActivitySystem)
        @ObservationIgnored private(set) lazy var liveActivityTokens = LiveActivityTokens(
            relay: RelayClient(asserter: SystemAppAttest()),
            host: { [weak self] in self?.pairing?.host },
            send: { [weak self] event in await self?.send(event) }
        )
        @ObservationIgnored let healthStore = HKHealthStore()
        @ObservationIgnored private(set) lazy var health = HealthDelivery(store: healthStore) { [weak self] event in
            await self?.send(event)
        }
    #endif
    @ObservationIgnored private let events = StoredEventQueue()
    #if os(macOS)
        /// Opens the window again, which may be closed while the app keeps running.
        @ObservationIgnored var showWindow: (() -> Void)?
    #endif

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }

    init() {
        notifier.onResponse = { [weak self] response in await self?.handle(response) }
        notifier.onProof = { [weak self] nonce in self?.push.proofArrived(nonce: nonce) }
        push.onGrantChange = { [weak self] host, grant in await self?.sendGrant(grant, to: host) }
        EventSender.model = self
        registerBridge()
        if let stored = StoredPairing.load() {
            activate(Pairing(host: stored.host, credentials: stored.credentials))
        }
        #if os(iOS)
            health.start()
            watchAlarms()
            LiveActivityEvents.send = { [weak self] event in await self?.send(event) }
            liveActivitySystem.watch(liveActivityTokens)
        #endif
        #if HOBWORK_DRIVER
            DriverHook.start(web: web)
        #endif
    }

    var api: HostAPI? {
        pairing.map { HostAPI(host: $0.host, token: $0.credentials.token) }
    }

    func completePairing(host: URL, exchange: PairingExchange) throws {
        try StoredPairing.save(host: host, credentials: exchange.credentials)
        notice = nil
        push.hostKeysChanged(host: host, keys: exchange.push)
        activate(Pairing(host: host, credentials: exchange.credentials))
    }

    /// Removes the device from the host and forgets the host: the device token, the web
    /// view's session and queued events. Local state goes even when the host can't be reached.
    func signOut(notice: String? = nil) async {
        if notice == nil { try? await api?.removeDevice() }
        connection?.stop()
        connection = nil
        if let host = pairing?.host { push.forget(host: host) }
        StoredPairing.remove()
        owner = nil
        events.removeAll()
        pairing = nil
        self.notice = notice
        await web.reset()
    }

    func sceneBecameActive() {
        guard pairing != nil else { return }
        #if os(iOS)
            if scanWhenActive {
                scanWhenActive = false
                Task { await scanTag() }
            }
        #endif
        if connection?.state == .connected { connection?.sayHello() } else { connection?.reconnect() }
        push.refresh()
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
        push.tokenArrived(token.hex, environment: .current)
    }

    /// A background push from the relay: renewals, and hosts withdrawing notifications.
    func didReceiveBackgroundPush(_ userInfo: [AnyHashable: Any]) async {
        switch RelayPush(userInfo: userInfo) {
        case let .renew(grants)?:
            await push.renew(grants: grants).value
        case let .sealed(grant, keyId, ciphertext)?:
            guard let opened = try? PushOpener().open(grant: grant, keyId: keyId, ciphertext: ciphertext) else { return }
            if let ids = opened.withdrawn { Notifier.withdraw(ids) }
            #if os(iOS)
                if opened.hobwork["reloadWidgets"] == .bool(true) { WidgetReloader.reloadAll() }
            #endif
        default:
            break
        }
    }

    private func sendGrant(_ grant: HostPushGrant?, to host: URL) async {
        guard let api, pairing?.host == host else { return }
        #if os(iOS)
            await liveActivityTokens.reportStartToken()
        #endif
        do {
            try await api.updatePush(grant)
        } catch HostError.unauthorized {
            await revoked()
        } catch {
            // The next hello carries the grant.
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

    #if os(iOS)
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
                let records = try await nfc.read(sheet: NFCSheet()).records
                guard let url = records.first(where: { $0.type == .url }).flatMap({ URL(string: $0.value) }) else {
                    nfcNotice = "This tag has no link, so there is nothing to send to your hobs."
                    return
                }
                await scanned(url, records: records)
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

        /// `hobwork://nfc/<tag>`, universal links to `<host>/nfc/<tag>`, and links to hob apps.
        /// A tag scanned in the background while a page of the hob that wrote it is open goes
        /// to that page (`nfc.scanned`), as does a link to a hob page that listens for it, and
        /// the app stays where it is.
        func open(_ url: URL) {
            guard let pairing else { return }
            if let link = HobLink(url: url) {
                web.open(link: link.webPath)
                return
            }
            if NFCTagLink.tag(from: url, host: pairing.host) != nil {
                Task { await scanned(url, records: nil) }
                return
            }
            guard let origin = web.linkPolicy?.hobOrigin(of: url) else { return }
            if web.bridge.router.listens("nfc.scanned", origin: origin) {
                Task { await scanned(url, records: nil) }
            } else {
                web.open(link: url.absoluteString)
            }
        }

        /// Sends a scanned link to the host's triggers and, when a page of the hob that wrote the
        /// tag (or of the hob the link points to) listens, to that page as `nfc.scanned`.
        private func scanned(_ url: URL, records: [NFCRecord]?) async {
            guard let pairing else { return }
            let router = web.bridge.router
            await send(NFCTagLink.event(url: url, records: records, host: pairing.host))
            var data: [String: JSONValue] = ["url": .string(url.absoluteString)]
            if let records { data["records"] = .array(records.map { .object(["type": .string($0.type.rawValue), "value": .string($0.value)]) }) }
            if let tag = NFCTagLink.tag(from: url, host: pairing.host) {
                let link = pairing.host.appending(path: "nfc/\(tag)")
                data["url"] = .string(link.absoluteString)
                data["tag"] = .string(tag)
                if let hob = try? await api?.nfcTagHob(url: link), router.listens("nfc.scanned", hob: hob) {
                    router.emit("nfc.scanned", data: .object(data), toHob: hob)
                    return
                }
            } else if let origin = web.linkPolicy?.hobOrigin(of: url), router.listens("nfc.scanned", origin: origin) {
                router.emit("nfc.scanned", data: .object(data), to: origin)
                return
            }
            nfcNotice = "Tag scanned."
        }

        /// Reports rings, stops and repeats of hobs' alarms while the app runs. The Stop and
        /// repeat intents report the rest.
        private func watchAlarms() {
            AlarmEventHook.report = { [weak self] kind, id in await self?.alarmEvents.answered(kind, id: id) }
            Task { [weak self] in
                for await alarms in AlarmManager.shared.alarmUpdates {
                    let scheduled = alarms.map { ScheduledAlarm(id: $0.id, state: AlarmKitScheduler.state($0.state)) }
                    await self?.alarmEvents.observe(scheduled)
                }
            }
        }

        private func deliver(_ report: AlarmEventReporter.Report) async {
            web.bridge.router.emit("alarms.\(report.kind.rawValue)", data: report.data, toHob: report.hob)
            var data = report.data.objectValue ?? [:]
            data["hob"] = .string(report.hob)
            await send(DeviceEvent(capability: AlarmsCapability.capability, name: report.kind.rawValue, data: .object(data)))
        }

        /// Asks iOS the first time a hob sets an alarm from its page.
        func authorizeAlarms() async -> Bool {
            if alarms.isAuthorized { return true }
            await requestAlarms()
            return alarms.isAuthorized
        }
    #endif

    private func activate(_ pairing: Pairing) {
        self.pairing = pairing
        let api = HostAPI(host: pairing.host, token: pairing.credentials.token)
        let runner = CommandRunner(log: FileCommandLog())
        runner.register(notifier, for: Notifier.capability)
        #if os(iOS)
            runner.register(NFCCapability(session: nfc, host: { [weak self] in self?.pairing?.host }), for: NFCCapability.capability)
            BackgroundCapabilities.register(on: runner, alarms: alarms, health: HealthKitReader(store: healthStore))
            runner.register(liveActivities, for: LiveActivities.capability)
            runner.register(WidgetsCapability(), for: WidgetsCapability.capability)
        #else
            BackgroundCapabilities.register(on: runner)
        #endif
        self.runner = runner
        let connection = DeviceConnection(
            request: api.webSocketRequest,
            hello: { [weak self] in self?.hello ?? Hello(appVersion: Self.appVersion, platform: Hello.platform, capabilities: []) },
            queue: events,
            runner: runner
        )
        connection.onUnauthorized = { [weak self] in Task { await self?.revoked() } }
        connection.onPush = { [weak self] keys in self?.push.hostKeysChanged(host: pairing.host, keys: keys) }
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
            #if os(iOS)
                HobworkShortcuts.updateAppShortcutParameters()
            #endif
        }
    }

    @ObservationIgnored private var runner: CommandRunner?

    // MARK: Web bridge

    @ObservationIgnored let printers = PrinterMemory()
    @ObservationIgnored private var owner: (host: URL, person: AppInfoBridge.Person)?

    private func registerBridge() {
        let router = web.bridge.router
        router.register(AppInfoBridge(
            deviceName: { [weak self] in self?.pairing?.credentials.name },
            person: { [weak self] in await self?.ownerOfDevice() }
        ))
        router.register(ClipboardBridge())
        router.register(LocalNotificationsBridge())
        router.register(PrintBridge(memory: printers))
        router.register(ShareBridge())
        let handoff: NFCBridge.Handoff = { [weak self] hob, device, method, args in
            guard let api = self?.api else { throw HostError.unreachable("This device isn't connected to a Hobwork host") }
            return try await api.handoff(hob: hob, device: device, capability: "nfc", method: method, args: args)
        }
        let host: () -> URL? = { [weak self] in self?.pairing?.host }
        #if os(iOS)
            router.register(HapticsBridge())
            router.register(CameraBridge(device: VisionKitCamera()))
            router.register(NFCBridge(session: nfc, host: host, handoff: handoff))
            router.register(AlarmsBridge(capability: AlarmsCapability(scheduler: alarms)) { [weak self] in
                await self?.authorizeAlarms() ?? false
            })
            router.register(LiveActivitiesBridge(activities: liveActivities) { [weak self] hob, op, id, args in
                guard let api = self?.api else { throw HostError.unreachable("This device isn't connected to a Hobwork host") }
                return try await api.liveActivity(hob: hob, op: op, id: id, args: args)
            })
        #else
            router.register(NFCBridge(host: host, handoff: handoff))
        #endif
    }

    /// Fetched once per pairing: owners do not change.
    private func ownerOfDevice() async -> AppInfoBridge.Person? {
        guard let pairing, let api else { return nil }
        if let owner, owner.host == pairing.host { return owner.person }
        guard let device = try? await api.describeSelf() else { return nil }
        let person = AppInfoBridge.Person(id: device.person.id, name: device.person.name)
        if self.pairing?.host == pairing.host { owner = (pairing.host, person) }
        return person
    }

    private var hello: Hello {
        Hello(
            appVersion: Self.appVersion,
            platform: Hello.platform,
            capabilities: capabilities.reported,
            push: pairing.flatMap { push.hostGrant(for: $0.host) },
            timeZone: TimeZone.current.identifier
        )
    }

    private func revoked() async {
        guard let host = pairing?.host.host() else { return }
        await signOut(notice: "This device was removed from \(host). Connect again to keep using it.")
    }

    private func handle(_ response: Notifier.Response) async {
        if let path = response.path {
            #if os(macOS)
                showWindow?()
            #endif
            web.open(link: path)
        }
        if let command = response.command { await run(command) }
        if let event = response.event { await send(event) }
    }

    /// A tapped command push. The extension already ran background commands; the command
    /// log answers those again, which is harmless since the host keeps the first result.
    private func run(_ command: DeviceCommand) async {
        guard let runner, let api else { return }
        #if os(iOS)
            // The person just tapped the prompt, so this is the moment to ask.
            if command.capability == AlarmsCapability.capability, !alarms.isAuthorized {
                await requestAlarms()
            }
        #endif
        let outcome = await runner.run(command)
        #if os(iOS)
            if let followUp = AlarmFollowUp.after(command, outcome: outcome, deviceName: DeviceModel.name) {
                alarmProblem = followUp.problem
                sheet = .alarms
            }
        #endif
        guard let outcome else { return }
        try? await api.send(DeviceCallResult(id: command.id, outcome: outcome.result))
    }
}
