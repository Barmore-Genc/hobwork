#if os(iOS)
    import CoreHaptics
    import UIKit

    /// `haptics`. Not on macOS: Mac haptics only reach a finger on a Force Touch trackpad
    /// while it drags. iPads and other devices without a haptic engine list no methods, so
    /// `has('haptics')` is false there.
    @MainActor
    final class HapticsBridge: BridgeCapability {
        let name = "haptics"
        let methods: [String]

        init(supported: Bool = CHHapticEngine.capabilitiesForHardware().supportsHaptics) {
            methods = supported ? ["lift", "tick", "success", "warning", "error", "impact"] : []
        }

        func call(_ method: String, args: JSONValue, context: BridgeContext) async throws -> JSONValue {
            switch method {
            case "lift":
                impact(.medium, intensity: nil)
            case "tick":
                UISelectionFeedbackGenerator().selectionChanged()
            case "success":
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "warning":
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
            case "error":
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            default:
                let style = try Self.style(args.string("style") ?? "medium")
                let intensity = try args.number("intensity")
                if let intensity, !(0 ... 1).contains(intensity) { throw BridgeError.failed("intensity must be between 0 and 1") }
                impact(style, intensity: intensity)
            }
            return .null
        }

        private func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle, intensity: Double?) {
            let generator = UIImpactFeedbackGenerator(style: style)
            if let intensity { generator.impactOccurred(intensity: intensity) } else { generator.impactOccurred() }
        }

        static func style(_ name: String) throws(BridgeError) -> UIImpactFeedbackGenerator.FeedbackStyle {
            switch name {
            case "light": .light
            case "medium": .medium
            case "heavy": .heavy
            case "soft": .soft
            case "rigid": .rigid
            default: throw .failed("style must be light, medium, heavy, soft or rigid")
            }
        }
    }
#endif
