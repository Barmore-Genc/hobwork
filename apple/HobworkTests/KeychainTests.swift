import Foundation
import Testing
@testable import Hobwork

@Suite(.serialized)
struct KeychainTests {
    let host = URL(string: "https://keychain-test.example.com")!
    let credentials = DeviceCredentials(deviceId: 7, name: "test-iphone", token: "hwd_test")

    @Test func movesItemsIntoTheSharedAccessGroup() throws {
        Keychain.delete(for: host)
        defer { Keychain.delete(for: host) }
        try Keychain.save(credentials, for: host, accessGroup: nil)

        #expect(Keychain.load(for: host) == credentials)
        #expect(Keychain.load(for: host, accessGroup: AppGroup.identifier) == credentials)
    }

    @Test func deletesFromEveryGroup() throws {
        try Keychain.save(credentials, for: host)
        Keychain.delete(for: host)
        #expect(Keychain.load(for: host) == nil)
    }
}
