import Foundation
@testable import Hobwork

@MainActor
final class FakeAlarmScheduler: AlarmScheduling {
    var isAuthorized = true
    var scheduled: [AlarmRecord] = []
    var cancelled: [UUID] = []
    var states: [UUID: AlarmState] = [:]
    var failure: AlarmSchedulingError?

    func schedule(_ alarm: AlarmRecord) async throws {
        if let failure { throw failure }
        scheduled.append(alarm)
        states[alarm.uuid!] = alarm.seconds == nil ? .scheduled : .countdown
    }

    func cancel(_ id: UUID) {
        cancelled.append(id)
        states[id] = nil
    }

    var endsAt: [UUID: Date] = [:]

    func alarms() throws -> [ScheduledAlarm] {
        states.map { ScheduledAlarm(id: $0.key, state: $0.value, endsAt: endsAt[$0.key]) }.sorted { $0.id.uuidString < $1.id.uuidString }
    }
}

@MainActor
final class FakeHealthReader: HealthReading {
    var samples: [HealthSample] = []
    var failure: HealthReadError?
    var queries: [(HealthType, Date, Date, Int)] = []

    func samples(of type: HealthType, from: Date, to: Date, limit: Int) async throws(HealthReadError) -> [HealthSample] {
        queries.append((type, from, to, limit))
        if let failure { throw failure }
        return samples
    }
}

@MainActor
final class FakeNFCSession: NFCTagSession {
    var isAvailable = true
    var read = NFCTagRead(records: [], uid: "04a2245a8b6380")
    var failure: NFCSessionError?
    var written: [(URL, String?)] = []
    var sheets: [NFCSheet] = []
    var alerts: [String] = []
    var stopped: [String?] = []
    private(set) var onTag: (@MainActor (NFCTagRead) -> Void)?
    private(set) var onEnd: (@MainActor (NFCScanEnd) -> Void)?

    var records: [NFCRecord] {
        get { read.records }
        set { read.records = newValue }
    }

    func read(sheet: NFCSheet) async throws(NFCSessionError) -> NFCTagRead {
        sheets.append(sheet)
        if let failure { throw failure }
        return read
    }

    func write(url: URL, text: String?, sheet: NFCSheet) async throws(NFCSessionError) -> NFCTagRead {
        sheets.append(sheet)
        if let failure { throw failure }
        written.append((url, text))
        return read
    }

    func startScan(
        sheet: NFCSheet,
        keepOpen: Bool,
        onTag: @escaping @MainActor (NFCTagRead) -> Void,
        onEnd: @escaping @MainActor (NFCScanEnd) -> Void
    ) throws(NFCSessionError) {
        if let failure { throw failure }
        guard self.onEnd == nil else { throw .busy }
        sheets.append(sheet)
        self.onTag = onTag
        self.onEnd = onEnd
    }

    func updateScan(alertMessage: String) {
        alerts.append(alertMessage)
    }

    func stopScan(message: String?) {
        stopped.append(message)
        end(.stopped)
    }

    /// A tag held near the fake reader.
    func tag(_ read: NFCTagRead) {
        onTag?(read)
    }

    func end(_ reason: NFCScanEnd) {
        let onEnd = onEnd
        self.onTag = nil
        self.onEnd = nil
        onEnd?(reason)
    }
}

@MainActor
final class FakeHomeKitStore: HomeKitStore {
    var homesList = [HomeKitHome(id: "H1", name: "Our House", isPrimary: true)]
    var accessoriesList = [
        HomeKitAccessory(id: "A1", name: "Lamp", room: "Default Room", serialNumber: "light.lamp", bridge: "HASS Bridge"),
        HomeKitAccessory(id: "A2", name: "Hue Bridge", room: nil, serialNumber: nil, bridge: nil),
    ]
    var failure: BridgeError?
    var accessoryQueries: [String] = []
    var assigned: [(accessory: String, room: String)] = []
    var renamed: [(accessory: String, name: String)] = []

    var serviceQueries: [String] = []
    var reads: [(accessory: String, characteristic: String)] = []
    var writes: [(accessory: String, characteristic: String, value: JSONValue)] = []
    var characteristic = HomeKitCharacteristic(id: "C1", type: "power", readable: true, writable: true, format: "bool")

    func services(accessory: String) async throws(BridgeError) -> [HomeKitService] {
        if let failure { throw failure }
        serviceQueries.append(accessory)
        return [HomeKitService(id: "S1", name: "Light", type: "light", characteristics: [characteristic])]
    }

    func get(accessory: String, characteristic: String) async throws(BridgeError) -> JSONValue {
        if let failure { throw failure }
        reads.append((accessory, characteristic))
        return .bool(true)
    }

    func set(accessory: String, characteristic: String, value: JSONValue) async throws(BridgeError) {
        if let failure { throw failure }
        try self.characteristic.validate(value)
        writes.append((accessory, characteristic, value))
    }

    func homes() async throws(BridgeError) -> [HomeKitHome] {
        if let failure { throw failure }
        return homesList
    }

    func accessories(home: String) async throws(BridgeError) -> [HomeKitAccessory] {
        accessoryQueries.append(home)
        if let failure { throw failure }
        return accessoriesList
    }

    func assignRoom(accessory: String, room: String) async throws(BridgeError) {
        if let failure { throw failure }
        assigned.append((accessory, room))
    }

    func rename(accessory: String, name: String) async throws(BridgeError) {
        if let failure { throw failure }
        renamed.append((accessory, name))
    }
}
