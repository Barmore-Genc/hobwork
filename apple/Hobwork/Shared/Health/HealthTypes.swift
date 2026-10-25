import Foundation
import HealthKit

enum HealthType: String, Codable, CodingKeyRepresentable, CaseIterable, Sendable {
    case sleep, steps, heartRate, restingHeartRate, activeEnergy, bodyMass, workouts, mindfulness

    var title: String {
        switch self {
        case .sleep: "Sleep"
        case .steps: "Steps"
        case .heartRate: "Heart rate"
        case .restingHeartRate: "Resting heart rate"
        case .activeEnergy: "Active energy"
        case .bodyMass: "Weight"
        case .workouts: "Workouts"
        case .mindfulness: "Mindfulness"
        }
    }

    var sampleType: HKSampleType {
        switch self {
        case .sleep: HKCategoryType(.sleepAnalysis)
        case .steps: HKQuantityType(.stepCount)
        case .heartRate: HKQuantityType(.heartRate)
        case .restingHeartRate: HKQuantityType(.restingHeartRate)
        case .activeEnergy: HKQuantityType(.activeEnergyBurned)
        case .bodyMass: HKQuantityType(.bodyMass)
        case .workouts: HKWorkoutType.workoutType()
        case .mindfulness: HKCategoryType(.mindfulSession)
        }
    }

    /// The unit quantities are reported in, as named on the wire and as an `HKUnit`.
    var unit: (name: String, unit: HKUnit)? {
        switch self {
        case .steps: ("count", .count())
        case .heartRate, .restingHeartRate: ("count/min", .count().unitDivided(by: .minute()))
        case .activeEnergy: ("kcal", .kilocalorie())
        case .bodyMass: ("kg", .gramUnit(with: .kilo))
        case .sleep, .workouts, .mindfulness: nil
        }
    }
}

struct HealthSample: Codable, Equatable, Sendable {
    var type: HealthType
    var start: String
    var end: String
    var value: Double?
    var unit: String?
    var stage: String?
    var workoutType: String?

    init(type: HealthType, start: Date, end: Date, value: Double? = nil, unit: String? = nil, stage: String? = nil, workoutType: String? = nil) {
        self.type = type
        self.start = ISODate.format(start)
        self.end = ISODate.format(end)
        self.value = value
        self.unit = unit
        self.stage = stage
        self.workoutType = workoutType
    }

    init?(_ sample: HKSample, type: HealthType) {
        let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60
        switch type {
        case .steps, .heartRate, .restingHeartRate, .activeEnergy, .bodyMass:
            guard let sample = sample as? HKQuantitySample, let unit = type.unit else { return nil }
            self.init(type: type, start: sample.startDate, end: sample.endDate, value: sample.quantity.doubleValue(for: unit.unit), unit: unit.name)
        case .sleep:
            guard let sample = sample as? HKCategorySample, let stage = HKCategoryValueSleepAnalysis(rawValue: sample.value).map(Self.stage) else { return nil }
            self.init(type: type, start: sample.startDate, end: sample.endDate, stage: stage)
        case .mindfulness:
            self.init(type: type, start: sample.startDate, end: sample.endDate, value: minutes, unit: "min")
        case .workouts:
            guard let workout = sample as? HKWorkout else { return nil }
            self.init(
                type: type, start: workout.startDate, end: workout.endDate, value: minutes, unit: "min",
                workoutType: Self.name(of: workout.workoutActivityType)
            )
        }
    }

    static func stage(_ value: HKCategoryValueSleepAnalysis) -> String {
        switch value {
        case .inBed: "inBed"
        case .awake: "awake"
        case .asleepCore: "core"
        case .asleepDeep: "deep"
        case .asleepREM: "rem"
        default: "asleep"
        }
    }

    static func name(of activity: HKWorkoutActivityType) -> String {
        switch activity {
        case .running: "running"
        case .walking: "walking"
        case .cycling: "cycling"
        case .swimming: "swimming"
        case .hiking: "hiking"
        case .yoga: "yoga"
        case .functionalStrengthTraining: "functionalStrengthTraining"
        case .traditionalStrengthTraining: "traditionalStrengthTraining"
        case .highIntensityIntervalTraining: "highIntensityIntervalTraining"
        case .elliptical: "elliptical"
        case .rowing: "rowing"
        case .stairClimbing: "stairClimbing"
        case .dance: "dance"
        case .pilates: "pilates"
        case .coreTraining: "coreTraining"
        case .mindAndBody: "mindAndBody"
        case .soccer: "soccer"
        case .tennis: "tennis"
        case .basketball: "basketball"
        case .climbing: "climbing"
        case .crossTraining: "crossTraining"
        case .mixedCardio: "mixedCardio"
        case .cooldown: "cooldown"
        case .flexibility: "flexibility"
        default: "other"
        }
    }
}

/// Whether the person connected Health, and the background delivery bookkeeping, in the app group.
struct HealthSharing: Codable, Equatable, Sendable {
    /// When Health was turned on. Background delivery sends samples of every type from then on.
    var connectedAt: Date?
    var anchors: [HealthType: Data] = [:]

    static let file = SharedFile(name: "health.json", empty: HealthSharing())

    var isConnected: Bool { connectedAt != nil }

    init(connectedAt: Date? = nil, anchors: [HealthType: Data] = [:]) {
        self.connectedAt = connectedAt
        self.anchors = anchors
    }

    private enum CodingKeys: String, CodingKey {
        case connectedAt, anchors
    }

    private enum LegacyKeys: String, CodingKey {
        case shared
    }

    /// Health used to be a switch per type, each with its own approval. Any approved type means
    /// the person had connected Health, and delivery keeps starting from the earliest approval.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        anchors = try container.decodeIfPresent([HealthType: Data].self, forKey: .anchors) ?? [:]
        if let connectedAt = try container.decodeIfPresent(Date.self, forKey: .connectedAt) {
            self.connectedAt = connectedAt
        } else {
            let legacy = try decoder.container(keyedBy: LegacyKeys.self)
            let shared = (try? legacy.decodeIfPresent([HealthType: Date].self, forKey: .shared)) ?? [:]
            connectedAt = shared.values.min()
        }
    }
}
