import Foundation
#if os(iOS)
    import HomeKit
#endif

struct HomeKitHome: Equatable, Sendable {
    var id: String
    var name: String
    var isPrimary: Bool
}

struct HomeKitAccessory: Equatable, Sendable {
    var id: String
    var name: String
    /// Nil when the accessory is in no room.
    var room: String?
    /// What the accessory reports as its serial number. Home Assistant sets it to the entity
    /// ID, so this is how a bridged accessory is matched back to its entity. Nil when the
    /// accessory has none or cannot be reached to ask.
    var serialNumber: String?
    /// The name of the bridge the accessory sits behind, or nil when it is not bridged.
    var bridge: String?
}

/// The person's Home, as far as hobs may use it: read homes and accessories, move an accessory
/// to a room and rename it. Everything else in HomeKit stays out of reach.
@MainActor
protocol HomeKitStore {
    func homes() async throws(BridgeError) -> [HomeKitHome]
    func accessories(home: String) async throws(BridgeError) -> [HomeKitAccessory]
    /// Moves the accessory to the room with this name, making the room when the home has none.
    func assignRoom(accessory: String, room: String) async throws(BridgeError)
    func rename(accessory: String, name: String) async throws(BridgeError)
}

#if os(iOS)
    /// Home through HomeKit. The `HMHomeManager` is made on first use, so iOS asks for Home
    /// access when a hob first needs it and not when the app starts.
    @MainActor
    final class SystemHomeKitStore: NSObject, HomeKitStore, HMHomeManagerDelegate {
        private var manager: HMHomeManager?
        private var loaded = false
        private var waiting: [CheckedContinuation<Void, Never>] = []
        /// How long to wait for iOS to hand over the homes, which includes the person
        /// answering the permission question.
        private let patience: Duration

        init(patience: Duration = .seconds(60)) {
            self.patience = patience
        }

        func homes() async throws(BridgeError) -> [HomeKitHome] {
            let manager = try await ready()
            let primary = manager.primaryHome?.uniqueIdentifier
            return manager.homes.map {
                HomeKitHome(id: $0.uniqueIdentifier.uuidString, name: $0.name, isPrimary: $0.uniqueIdentifier == primary)
            }
        }

        func accessories(home id: String) async throws(BridgeError) -> [HomeKitAccessory] {
            let manager = try await ready()
            guard let home = manager.homes.first(where: { $0.uniqueIdentifier.uuidString == id }) else {
                throw .failed("There is no home with that ID", reason: "unknown_home")
            }
            var bridgeNames: [UUID: String] = [:]
            for accessory in home.accessories {
                for child in accessory.uniqueIdentifiersForBridgedAccessories ?? [] { bridgeNames[child] = accessory.name }
            }
            var result: [HomeKitAccessory] = []
            for accessory in home.accessories {
                result.append(HomeKitAccessory(
                    id: accessory.uniqueIdentifier.uuidString,
                    name: accessory.name,
                    room: accessory.room?.name,
                    serialNumber: await Self.serialNumber(of: accessory),
                    bridge: bridgeNames[accessory.uniqueIdentifier]
                ))
            }
            return result
        }

        func assignRoom(accessory id: String, room: String) async throws(BridgeError) {
            let (home, accessory) = try await find(accessory: id)
            let existing = home.rooms.first { $0.name.compare(room, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
            do {
                let target: HMRoom
                if let existing {
                    target = existing
                } else {
                    target = try await home.addRoom(named: room)
                }
                if accessory.room?.uniqueIdentifier == target.uniqueIdentifier { return }
                try await home.assignAccessory(accessory, to: target)
            } catch {
                throw .failed(error.localizedDescription, reason: "homekit")
            }
        }

        func rename(accessory id: String, name: String) async throws(BridgeError) {
            let (_, accessory) = try await find(accessory: id)
            do {
                try await accessory.updateName(name)
            } catch {
                throw .failed(error.localizedDescription, reason: "homekit")
            }
        }

        // MARK: Loading

        private func ready() async throws(BridgeError) -> HMHomeManager {
            let manager: HMHomeManager
            if let existing = self.manager {
                manager = existing
            } else {
                manager = HMHomeManager()
                manager.delegate = self
                self.manager = manager
            }
            if !loaded { await waitUntilLoaded() }
            let status = manager.authorizationStatus
            if status.contains(.restricted) { throw BridgeError(code: .denied, message: "Home is restricted on this device", reason: "restricted") }
            if !status.contains(.determined) { throw .unavailable("Home did not answer in time") }
            if !status.contains(.authorized) { throw BridgeError(code: .denied, message: "Allow Hobwork to use Home in Settings", reason: "not_authorized") }
            return manager
        }

        private func waitUntilLoaded() async {
            await withCheckedContinuation { continuation in
                waiting.append(continuation)
                let patience = patience
                Task { [weak self] in
                    try? await Task.sleep(for: patience)
                    self?.finishWaiting()
                }
            }
        }

        private func finishWaiting() {
            let all = waiting
            waiting = []
            for continuation in all { continuation.resume() }
        }

        private func find(accessory id: String) async throws(BridgeError) -> (HMHome, HMAccessory) {
            let manager = try await ready()
            for home in manager.homes {
                if let accessory = home.accessories.first(where: { $0.uniqueIdentifier.uuidString == id }) { return (home, accessory) }
            }
            throw .failed("There is no accessory with that ID", reason: "unknown_accessory")
        }

        private static func serialNumber(of accessory: HMAccessory) async -> String? {
            let characteristic = accessory.services
                .first { $0.serviceType == HMServiceTypeAccessoryInformation }?
                .characteristics.first { $0.characteristicType == HMCharacteristicTypeSerialNumber }
            guard let characteristic else { return nil }
            if let cached = characteristic.value as? String, !cached.isEmpty { return cached }
            guard accessory.isReachable else { return nil }
            try? await characteristic.readValue()
            return (characteristic.value as? String).flatMap { $0.isEmpty ? nil : $0 }
        }

        // MARK: HMHomeManagerDelegate

        nonisolated func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
            Task { @MainActor in
                self.loaded = true
                self.finishWaiting()
            }
        }

        nonisolated func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
            // A "no" never delivers homes, so answer the waiting call now.
            guard status.contains(.determined), !status.contains(.authorized) else { return }
            Task { @MainActor in
                self.loaded = true
                self.finishWaiting()
            }
        }
    }
#endif
