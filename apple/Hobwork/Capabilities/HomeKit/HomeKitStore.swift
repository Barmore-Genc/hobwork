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

struct HomeKitService: Equatable, Sendable {
    var id: String
    var name: String
    var type: String
    var characteristics: [HomeKitCharacteristic]

    var json: JSONValue {
        .object(["id": .string(id), "name": .string(name), "type": .string(type), "characteristics": .array(characteristics.map(\.json))])
    }
}

struct HomeKitCharacteristic: Equatable, Sendable {
    var id: String
    var type: String
    var readable: Bool
    var writable: Bool
    var format: String?
    var unit: String?
    var min: Double?
    var max: Double?
    var step: Double?

    var json: JSONValue {
        .object([
            "id": .string(id), "type": .string(type), "readable": .bool(readable), "writable": .bool(writable),
            "format": format.map(JSONValue.string) ?? .null, "unit": unit.map(JSONValue.string) ?? .null,
            "min": min.map(JSONValue.number) ?? .null, "max": max.map(JSONValue.number) ?? .null,
            "step": step.map(JSONValue.number) ?? .null,
        ])
    }

    func validate(_ value: JSONValue) throws(BridgeError) {
        guard writable else { throw .failed("This characteristic is not writable", reason: "not_writable") }
        switch (format, value) {
        case ("bool", .bool), ("string", .string): return
        case ("int", .number), ("uint8", .number), ("uint16", .number), ("uint32", .number), ("uint64", .number), ("float", .number):
            guard let number = value.numberValue, number.isFinite else { throw .failed("value must be finite") }
            if format != "float", number.rounded() != number { throw .failed("value must be a whole number") }
            if let format, format.hasPrefix("uint"), number < 0 { throw .failed("value must not be negative") }
            if let min, number < min { throw .failed("value is below the characteristic minimum") }
            if let max, number > max { throw .failed("value is above the characteristic maximum") }
            if let step, step > 0 {
                let steps = (number - (min ?? 0)) / step
                guard abs(steps - steps.rounded()) < 0.000001 else { throw .failed("value does not match the characteristic step") }
            }
        default:
            throw .failed("value does not match the characteristic format", reason: "invalid_value")
        }
    }
}

/// Home access shared by the UI bridge and device commands, with a fake in tests.
@MainActor
protocol HomeKitStore {
    func services(accessory: String) async throws(BridgeError) -> [HomeKitService]
    func get(accessory: String, characteristic: String) async throws(BridgeError) -> JSONValue
    func set(accessory: String, characteristic: String, value: JSONValue) async throws(BridgeError)
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

        func services(accessory id: String) async throws(BridgeError) -> [HomeKitService] {
            let (_, accessory) = try await find(accessory: id)
            return accessory.services.map { service in
                HomeKitService(
                    id: service.uniqueIdentifier.uuidString,
                    name: service.name,
                    type: service.serviceType,
                    characteristics: service.characteristics.map(Self.describe)
                )
            }
        }

        func get(accessory: String, characteristic id: String) async throws(BridgeError) -> JSONValue {
            let characteristic = try await find(accessory: accessory, characteristic: id)
            guard characteristic.properties.contains(HMCharacteristicPropertyReadable) else {
                throw .failed("This characteristic is not readable", reason: "not_readable")
            }
            do {
                try await characteristic.readValue()
            } catch {
                throw .failed(error.localizedDescription, reason: "homekit")
            }
            guard let value = characteristic.value else { return .null }
            guard let json = JSONValue(foundationValue: value) else {
                throw .failed("This characteristic has an unsupported value", reason: "unsupported_format")
            }
            switch json {
            case .null, .bool, .number, .string: return json
            default: throw .failed("This characteristic has an unsupported value", reason: "unsupported_format")
            }
        }

        func set(accessory: String, characteristic id: String, value: JSONValue) async throws(BridgeError) {
            let characteristic = try await find(accessory: accessory, characteristic: id)
            try Self.describe(characteristic).validate(value)
            do {
                try await characteristic.writeValue(value.foundationValue)
            } catch {
                throw .failed(error.localizedDescription, reason: "homekit")
            }
        }

        private func find(accessory: String, characteristic id: String) async throws(BridgeError) -> HMCharacteristic {
            let (_, accessory) = try await find(accessory: accessory)
            guard accessory.isReachable else { throw .failed("Accessory is not reachable", reason: "unreachable") }
            guard let characteristic = accessory.services.flatMap(\.characteristics).first(where: { $0.uniqueIdentifier.uuidString == id }) else {
                throw .failed("There is no characteristic with that ID on this accessory", reason: "unknown_characteristic")
            }
            return characteristic
        }

        private static func describe(_ characteristic: HMCharacteristic) -> HomeKitCharacteristic {
            let metadata = characteristic.metadata
            return HomeKitCharacteristic(
                id: characteristic.uniqueIdentifier.uuidString,
                type: characteristic.characteristicType,
                readable: characteristic.properties.contains(HMCharacteristicPropertyReadable),
                writable: characteristic.properties.contains(HMCharacteristicPropertyWritable),
                format: metadata?.format,
                unit: metadata?.units,
                min: metadata?.minimumValue?.doubleValue,
                max: metadata?.maximumValue?.doubleValue,
                step: metadata?.stepValue?.doubleValue
            )
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
