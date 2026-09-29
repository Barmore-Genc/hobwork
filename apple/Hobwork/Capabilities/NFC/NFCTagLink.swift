import Foundation

/// URLs of NFC tags Hobwork wrote: `<host>/nfc/<tag>`, and `hobwork://nfc/<tag>` from the
/// host's page for the tag.
enum NFCTagLink {
    static func tag(from url: URL, host: URL?) -> String? {
        guard let scheme = url.scheme?.lowercased() else { return nil }
        let components = url.pathComponents.filter { $0 != "/" }
        if scheme == Pairing.callbackScheme {
            guard url.host?.lowercased() == "nfc", components.count == 1 else { return nil }
            return validTag(components[0])
        }
        guard let host, ["http", "https"].contains(scheme), scheme == host.scheme?.lowercased(),
              url.host?.lowercased() == host.host?.lowercased(), url.port == host.port,
              components.count == 2, components[0] == "nfc"
        else { return nil }
        return validTag(components[1])
    }

    static func event(tag: String) -> DeviceEvent {
        DeviceEvent(capability: NFCCapability.capability, name: "scanned", data: .object(["tag": .string(tag)]))
    }

    private static func validTag(_ text: String) -> String? {
        let allowed = (1 ... 128).contains(text.count) && text.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_"
        }
        return allowed ? text : nil
    }
}
