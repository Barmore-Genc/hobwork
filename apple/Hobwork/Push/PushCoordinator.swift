import CryptoKit
import Foundation

/// Keeps this device's relay registration and a grant per pairing: registers the APNs
/// token (with App Attest where the device has it), answers the ownership proof, makes,
/// renews and replaces grants, and tells the host when a grant changes.
@MainActor
final class PushCoordinator {
    struct Timing {
        var poll: Duration = .seconds(2)
        /// Polls without a proof before asking the relay for another proof push.
        var pollsBeforeProofPush = 15
        /// Polls before giving up until the next launch or token.
        var maxPolls = 90
        /// Grants with less left than this are renewed.
        var renewBefore: TimeInterval = 15 * 24 * 60 * 60
    }

    /// Called with the pairing's host and its new grant, or nil when it has none.
    var onGrantChange: ((URL, HostPushGrant?) async -> Void)?

    private let relay: RelayClient
    private let store: PushStore
    private let attester: (any AppAttesting)?
    private let proofInbox: SharedFile<ProofNotice?>
    private let timing: Timing
    private let now: () -> Date
    private let sleep: Sleep

    private var token: (value: String, environment: PushEnvironment)?
    private var last: Task<Void, Never>?

    init(
        relay: RelayClient,
        store: PushStore = PushStore(),
        attester: (any AppAttesting)?,
        proofInbox: SharedFile<ProofNotice?> = ProofInbox.file,
        timing: Timing = Timing(),
        now: @escaping () -> Date = { .now },
        sleep: @escaping Sleep = { try await Task.sleep(for: $0) }
    ) {
        self.relay = relay
        self.store = store
        self.attester = attester
        self.proofInbox = proofInbox
        self.timing = timing
        self.now = now
        self.sleep = sleep
    }

    /// The grant the host gets in `hello`, nil while there is none.
    func hostGrant(for host: URL) -> HostPushGrant? {
        store.pairing(for: host)?.hostGrant
    }

    @discardableResult
    func tokenArrived(_ token: String, environment: PushEnvironment) -> Task<Void, Never> {
        enqueue {
            self.token = (token, environment)
            if await self.register() { await self.reconcile() }
        }
    }

    /// The push keys from the token exchange or the host's `push` message. Nil, or a
    /// relay other than the built-in one, turns push off for that host.
    @discardableResult
    func hostKeysChanged(host: URL, keys: HostPushKeys?) -> Task<Void, Never> {
        enqueue {
            guard let keys, keys.relay == RelayClient.builtInURL else {
                await self.removePairing(host, tellHost: true)
                return
            }
            var pairing = self.store.pairing(for: host) ?? PushPairing(host: host, keys: keys)
            let isNew = pairing.keys != keys || pairing.grant == nil
            _ = pairing.update(keys)
            try? self.store.save(pairing)
            if isNew { await self.reconcile() }
        }
    }

    /// When the app starts or comes to the foreground: finishes a pending registration
    /// and renews grants that expire soon.
    @discardableResult
    func refresh() -> Task<Void, Never> {
        enqueue {
            if self.store.registration()?.status != .active {
                guard await self.register() else { return }
            }
            await self.reconcile()
        }
    }

    /// A renewal push listing grants.
    @discardableResult
    func renew(grants: [String]) -> Task<Void, Never> {
        enqueue {
            guard let registration = self.store.registration(), registration.status == .active else { return }
            for pairing in self.store.pairings() where pairing.grant.map({ grants.contains($0.id) }) == true {
                await self.renew(pairing, registration: registration)
            }
        }
    }

    /// Unpairing: the grant goes, so the host can no longer push.
    @discardableResult
    func forget(host: URL) -> Task<Void, Never> {
        enqueue { await self.removePairing(host, tellHost: false) }
    }

    /// A proof push the app saw itself, in the foreground.
    func proofArrived(nonce: String) {
        proofInbox.update { $0 = ProofNotice(nonce: nonce, receivedAt: self.now()) }
    }

    private func enqueue(_ operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = last
        let task = Task { @MainActor in
            await previous?.value
            await operation()
        }
        last = task
        return task
    }

    // MARK: Registration

    /// Creates or updates the registration with the current token and waits for its proof.
    /// Returns whether it is active.
    private func register() async -> Bool {
        guard let token else { return store.registration()?.status == .active }
        if var registration = store.registration() {
            if registration.status == .active, registration.token == token.value, registration.environment == token.environment {
                return true
            }
            proofInbox.update { $0 = nil }
            do {
                registration.status = try await relay.update(registration.auth, token: token.value, environment: token.environment)
            } catch {
                guard isLost(error) else { return false }
                await dropRegistration()
                return await create(token.value, environment: token.environment)
            }
            registration.token = token.value
            registration.environment = token.environment
            try? store.save(registration)
            if registration.status == .active { return true }
            return await awaitProof(registration)
        }
        return await create(token.value, environment: token.environment)
    }

    private func create(_ token: String, environment: PushEnvironment) async -> Bool {
        var attestation: RelayAttestation?
        if let attester, attester.isSupported {
            do {
                let challenge = try await relay.createChallenge()
                let keyId = try await attester.generateKey()
                let object = try await attester.attestKey(keyId, clientDataHash: Data(SHA256.hash(data: Data(challenge.utf8))))
                attestation = RelayAttestation(keyId: keyId, object: object.base64EncodedString(), challenge: challenge)
            } catch where SystemAppAttest.isUnsupported(error) {
                attestation = nil
            } catch {
                return false
            }
        }
        proofInbox.update { $0 = nil }
        let created: RelayRegistrationCreated
        do {
            created = try await relay.register(token: token, environment: environment, attestation: attestation)
        } catch let error as RelayError where error.code == "bad_attestation" {
            // An attestation the relay cannot check, as some Macs may make, still leaves
            // a registration without one.
            guard let unattested = try? await relay.register(token: token, environment: environment, attestation: nil) else { return false }
            attestation = nil
            created = unattested
        } catch {
            return false
        }
        let registration = StoredRelayRegistration(
            id: created.id,
            secret: created.secret,
            attestKeyId: attestation?.keyId,
            token: token,
            environment: environment,
            status: created.status
        )
        do {
            try store.save(registration)
        } catch {
            try? await relay.delete(registration.auth)
            return false
        }
        if registration.status == .active { return true }
        return await awaitProof(registration)
    }

    /// The extension writes the proof push's nonce to the app group, and sends it itself
    /// for a registration without App Attest. Waits for either, asking for another proof
    /// push when none comes.
    private func awaitProof(_ registration: StoredRelayRegistration) async -> Bool {
        var registration = registration
        for poll in 1 ... timing.maxPolls {
            if let notice = proofInbox.read() {
                var active = notice.confirmed
                if !active {
                    do {
                        active = try await relay.proof(registration.auth, nonce: notice.nonce) == .active
                    } catch let error as RelayError where error.code == "bad_nonce" {
                        proofInbox.update { $0 = nil }
                    } catch {
                        if isLost(error) { await dropRegistration() }
                        return false
                    }
                }
                if active {
                    proofInbox.update { $0 = nil }
                    registration.status = .active
                    try? store.save(registration)
                    return true
                }
            }
            if poll % timing.pollsBeforeProofPush == 0 {
                do {
                    try await relay.proofPush(registration.auth)
                } catch let error as RelayError where error.code == "nothing_pending" {
                    // Someone else confirmed it, or it was active all along.
                    if let info = try? await relay.registration(registration.auth), info.status == .active {
                        registration.status = .active
                        try? store.save(registration)
                        return true
                    }
                } catch {
                    if isLost(error) {
                        await dropRegistration()
                        return false
                    }
                }
            }
            do { try await sleep(timing.poll) } catch { return false }
        }
        return false
    }

    /// The relay no longer knows the registration, or the App Attest key is gone: start over.
    private func dropRegistration() async {
        store.removeRegistration()
        await clearGrants()
    }

    /// The registration's token is gone: its grants answer `gone` until a new token is
    /// confirmed, which deletes them.
    private func markGone() async {
        guard var registration = store.registration() else { return }
        registration.status = .gone
        try? store.save(registration)
        await clearGrants()
    }

    private func clearGrants() async {
        for var pairing in store.pairings() where pairing.grant != nil {
            pairing.grant = nil
            try? store.save(pairing)
            await onGrantChange?(pairing.host, nil)
        }
    }

    private func isLost(_ error: Error) -> Bool {
        if let error = error as? RelayError, case let .refused(status, code, _) = error {
            return status == 401 && code == "unauthorized"
        }
        return SystemAppAttest.isLostKey(error)
    }

    private func isGone(_ error: Error) -> Bool {
        ["gone", "not_active"].contains((error as? RelayError)?.code)
    }

    // MARK: Grants

    /// Makes a grant for every pairing without a current one and renews those that expire
    /// soon, comparing with what the relay has.
    private func reconcile(again: Bool = true) async {
        guard let registration = store.registration(), registration.status == .active else { return }
        var known: [String: RelayGrantInfo]?
        do {
            let info = try await relay.registration(registration.auth)
            if info.status == .gone {
                await markGone()
                if again, await register() { await reconcile(again: false) }
                return
            }
            known = Dictionary(info.grants.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        } catch {
            if isLost(error) {
                await dropRegistration()
                if again, await register() { await reconcile(again: false) }
                return
            }
            // Offline: work from what is stored.
        }
        for pairing in store.pairings() {
            guard let grant = pairing.grant else {
                guard await makeGrant(for: pairing, registration: registration) else { return }
                continue
            }
            if grant.signingKey != pairing.keys.signingKey || known.map({ $0[grant.id] == nil }) == true {
                guard await makeGrant(for: pairing, registration: registration) else { return }
            } else if grant.expiresAt.timeIntervalSince(now()) < timing.renewBefore {
                guard await renew(pairing, registration: registration) else { return }
            }
        }
    }

    /// Returns false when the registration can't take grants right now.
    @discardableResult
    private func makeGrant(for pairing: PushPairing, registration: StoredRelayRegistration) async -> Bool {
        var pairing = pairing
        let old = pairing.grant
        let created: RelayGrantInfo
        do {
            created = try await relay.createGrant(registration.auth, pairing: pairing.pairingId, publicKey: pairing.keys.signingKey)
        } catch {
            if isGone(error) { await markGone() }
            if isLost(error) { await dropRegistration() }
            return false
        }
        pairing.grant = PushPairing.Grant(
            id: created.id,
            expiresAt: Date(timeIntervalSince1970: TimeInterval(created.expiresAt)),
            signingKey: pairing.keys.signingKey
        )
        try? store.save(pairing)
        // A new grant for the same pairing replaces the old one on the relay, but one for a
        // pairing ID it never saw would not.
        if let old, old.id != created.id { try? await relay.deleteGrant(registration.auth, grant: old.id) }
        await onGrantChange?(pairing.host, pairing.hostGrant)
        return true
    }

    @discardableResult
    private func renew(_ pairing: PushPairing, registration: StoredRelayRegistration) async -> Bool {
        guard var grant = pairing.grant else { return true }
        var pairing = pairing
        do {
            let expiresAt = try await relay.renewGrant(registration.auth, grant: grant.id)
            grant.expiresAt = Date(timeIntervalSince1970: TimeInterval(expiresAt))
            pairing.grant = grant
            try? store.save(pairing)
            return true
        } catch let error as RelayError where ["expired", "unknown_grant"].contains(error.code) {
            pairing.grant = nil
            try? store.save(pairing)
            return await makeGrant(for: pairing, registration: registration)
        } catch {
            if isGone(error) { await markGone() }
            if isLost(error) { await dropRegistration() }
            return false
        }
    }

    private func removePairing(_ host: URL, tellHost: Bool) async {
        guard let pairing = store.pairing(for: host) else { return }
        store.removePairing(for: host)
        guard let grant = pairing.grant else { return }
        if let registration = store.registration() {
            try? await relay.deleteGrant(registration.auth, grant: grant.id)
        }
        if tellHost { await onGrantChange?(host, nil) }
    }
}
