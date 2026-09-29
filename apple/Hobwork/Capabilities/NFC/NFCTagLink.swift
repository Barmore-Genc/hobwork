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

    /// Schemes `nfc.write` takes: what iOS opens from a tag without an app, as on the host.
    static let writableSchemes: Set<String> = ["http", "https", "mailto", "tel", "sms", "facetime", "facetime-audio", "shortcuts"]

    /// The host drops scans with more or larger records; tags rarely come close.
    static let maxRecords = 16
    static let maxRecordBytes = 8192

    static func event(tag: String) -> DeviceEvent {
        DeviceEvent(capability: NFCCapability.capability, name: "scanned", data: .object(["tag": .string(tag)]))
    }

    /// The `scanned` event for a URL from a tag or a Shortcut: the tag for Hobwork tags of this
    /// host, the URL otherwise, so the host runs the triggers whose `url` matches. `records` are
    /// the tag's records when the app read it.
    static func event(url: URL, records: [NFCRecord]? = nil, host: URL?) -> DeviceEvent {
        var data: [String: JSONValue] = [:]
        if let tag = tag(from: url, host: host) {
            data["tag"] = .string(tag)
        } else {
            data["url"] = .string(url.absoluteString)
        }
        if let records {
            let sent = records.filter { $0.value.utf8.count <= maxRecordBytes }.prefix(maxRecords)
            data["records"] = .array(sent.map { .object(["type": .string($0.type.rawValue), "value": .string($0.value)]) })
        }
        return DeviceEvent(capability: NFCCapability.capability, name: "scanned", data: .object(data))
    }

    /// The event for a tag the app read, from its first URL record. Nil for a tag without one.
    static func event(records: [NFCRecord], host: URL?) -> DeviceEvent? {
        guard let url = records.first(where: { $0.type == .url }).flatMap({ URL(string: $0.value) }) else { return nil }
        return event(url: url, records: records, host: host)
    }

    private static func validTag(_ text: String) -> String? {
        let allowed = (1 ... 128).contains(text.count) && text.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_"
        }
        return allowed ? text : nil
    }
}
