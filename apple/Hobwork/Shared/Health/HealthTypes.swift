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
    var source: String

    init(type: HealthType, start: Date, end: Date, value: Double? = nil, unit: String? = nil, stage: String? = nil, workoutType: String? = nil, source: String) {
        self.type = type
        self.start = ISODate.format(start)
        self.end = ISODate.format(end)
        self.value = value
        self.unit = unit
        self.stage = stage
        self.workoutType = workoutType
        self.source = source
    }

    init?(_ sample: HKSample, type: HealthType) {
        let source = sample.sourceRevision.source.name
        let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60
        switch type {
        case .steps, .heartRate, .restingHeartRate, .activeEnergy, .bodyMass:
            guard let sample = sample as? HKQuantitySample, let unit = type.unit else { return nil }
            self.init(type: type, start: sample.startDate, end: sample.endDate, value: sample.quantity.doubleValue(for: unit.unit), unit: unit.name, source: source)
        case .sleep:
            guard let sample = sample as? HKCategorySample, let stage = HKCategoryValueSleepAnalysis(rawValue: sample.value).map(Self.stage) else { return nil }
            self.init(type: type, start: sample.startDate, end: sample.endDate, stage: stage, source: source)
        case .mindfulness:
            self.init(type: type, start: sample.startDate, end: sample.endDate, value: minutes, unit: "min", source: source)
        case .workouts:
            guard let workout = sample as? HKWorkout else { return nil }
            self.init(
                type: type, start: workout.startDate, end: workout.endDate, value: minutes, unit: "min",
                workoutType: Self.name(of: workout.workoutActivityType), source: source
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

/// Which types the person shares, and the background delivery bookkeeping, in the app group.
struct HealthSharing: Codable, Equatable, Sendable {
    /// When each shared type was turned on. Background delivery sends samples from then on.
    var shared: [HealthType: Date] = [:]
    var anchors: [HealthType: Data] = [:]

    static let file = SharedFile(name: "health.json", empty: HealthSharing())

    var types: Set<HealthType> { Set(shared.keys) }
}
