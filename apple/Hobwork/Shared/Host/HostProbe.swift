import Foundation

/// `GET /.well-known/hobwork`.
struct HostInfo: Decodable, Equatable, Sendable {
    /// The newest device protocol version this app speaks.
    static let supportedProtocol = 1

    var hobwork: Int
    var name: String
    var version: String

    static func parse(status: Int, data: Data) throws(HostProbeError) -> HostInfo {
        guard (200 ..< 300).contains(status) else { throw .notHobwork(status: status) }
        struct Marker: Decodable { var hobwork: Int }
        guard let marker = try? JSONDecoder().decode(Marker.self, from: data) else { throw .notHobwork(status: nil) }
        guard marker.hobwork <= supportedProtocol else { throw .unsupportedVersion(marker.hobwork) }
        guard let info = try? JSONDecoder().decode(HostInfo.self, from: data) else { throw .notHobwork(status: nil) }
        return info
    }
}

/// Why an address is not a Hobwork host the app can pair with, worded for the person
/// typing it in.
enum HostProbeError: Error, Equatable, LocalizedError {
    case offline
    case hostNotFound
    case connectionRefused
    case timedOut
    case unreachable(String)
    case certificate
    /// Plain http to an address iOS only allows over https.
    case insecure
    case notHobwork(status: Int?)
    case unsupportedVersion(Int)

    init(_ error: Error) {
        guard let error = error as? URLError else {
            self = .unreachable(error.localizedDescription)
            return
        }
        switch error.code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
            self = .offline
        case .cannotFindHost, .dnsLookupFailed:
            self = .hostNotFound
        case .cannotConnectToHost:
            self = .connectionRefused
        case .timedOut:
            self = .timedOut
        case .appTransportSecurityRequiresSecureConnection:
            self = .insecure
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected,
             .clientCertificateRequired:
            self = .certificate
        default:
            self = .unreachable(error.localizedDescription)
        }
    }

    var errorDescription: String? {
        switch self {
        case .offline:
            "This device is offline. Connect to the internet and try again."
        case .hostNotFound:
            "Couldn't find a server at this address. Check it for typos."
        case .connectionRefused:
            "The server refused the connection. Check that Hobwork is running and the port is right."
        case .timedOut:
            "The server took too long to answer. Check that it is running and reachable from this network."
        case let .unreachable(reason):
            "Couldn't reach the server: \(reason)"
        case .certificate:
            "The server's certificate isn't valid, so the connection isn't secure. Check the certificate on the server."
        case .insecure:
            "This address needs https. Plain http only works for local addresses such as localhost, .local names and IP addresses."
        case let .notHobwork(status?):
            "The server answered, but it isn't a Hobwork host (HTTP \(status)). Check the address."
        case .notHobwork(nil):
            "The server answered, but it isn't a Hobwork host. Check the address."
        case .unsupportedVersion:
            "This Hobwork host needs a newer version of the app. Update Hobwork and try again."
        }
    }
}
