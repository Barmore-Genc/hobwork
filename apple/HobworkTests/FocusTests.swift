import Foundation
import Testing
@testable import Hobwork

struct FocusTests {
    @Test func reportsFocusChanges() {
        var labels = FocusLabels()
        #expect(labels.apply(label: "work") == [FocusLabels.event(label: "work", active: true)])
        #expect(labels.active == ["work"])
        #expect(labels.setUp)

        #expect(labels.apply(label: "sleep") == [
            FocusLabels.event(label: "work", active: false),
            FocusLabels.event(label: "sleep", active: true),
        ])
        #expect(labels.apply(label: nil) == [FocusLabels.event(label: "sleep", active: false)])
        #expect(labels.active.isEmpty)
        #expect(labels.apply(label: nil).isEmpty)
    }

    @Test func treatsBlankLabelsAsOff() {
        var labels = FocusLabels(active: ["work"], setUp: true)
        #expect(labels.apply(label: "  ") == [FocusLabels.event(label: "work", active: false)])
        #expect(labels.apply(label: " gym ") == [FocusLabels.event(label: "gym", active: true)])
    }

    @Test func encodesChangedEvents() throws {
        let event = FocusLabels.event(label: "work", active: true)
        #expect(try DeviceMessage.event(event).encoded()
            == #"{"capability":"focus","data":{"active":true,"label":"work"},"name":"changed","type":"event"}"#)
    }

    @Test @MainActor func answersStatus() async throws {
        let file = temporaryFile(FocusLabels())
        file.update { $0.active = ["work"] }
        #expect(try await FocusCapability(file: file).handle(method: "status", args: nil) == json(#"{"active":["work"]}"#))
    }
}
