import Foundation
import Testing
import UserNotifications
@testable import Hobwork

struct NotificationTests {
    let notification = HobworkNotification(
        id: "n_1",
        project: "filament",
        title: "Filament low",
        body: "80 g left",
        actions: [NotificationAction(id: "reorder", title: "Reorder"), NotificationAction(id: "ignore", title: "Ignore")]
    )

    @Test func decodesSendArguments() throws {
        let args = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"id":"n_1","project":"filament","title":"Filament low","body":"80 g left",
         "actions":[{"id":"reorder","title":"Reorder"},{"id":"ignore","title":"Ignore"}]}
        """#.utf8))
        #expect(try args.decode(as: HobworkNotification.self) == notification)
    }

    @Test func needsAnIdAndATitle() throws {
        let args = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"title":"No id"}"#.utf8))
        #expect(throws: DecodingError.self) { try args.decode(as: HobworkNotification.self) }
    }

    @Test func readsPushPayloads() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Filament low", "body": "80 g left"], "category": "hobwork.n_1", "mutable-content": 1],
            "hobwork": [
                "id": "n_1",
                "project": "filament",
                "actions": [["id": "reorder", "title": "Reorder"], ["id": "ignore", "title": "Ignore"]],
            ],
        ]
        #expect(NotificationPayload(userInfo: userInfo) == notification.payload)
    }

    @Test func readsPushesWithoutActions() {
        let userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "Done"]], "hobwork": ["id": "n_2", "project": "filament"]]
        #expect(NotificationPayload(userInfo: userInfo) == NotificationPayload(id: "n_2", project: "filament", actions: nil))
    }

    @Test func roundTripsThroughLocalUserInfo() {
        let userInfo: [AnyHashable: Any] = [NotificationPayload.userInfoKey: notification.payload.userInfoValue]
        #expect(NotificationPayload(userInfo: userInfo) == notification.payload)
    }

    @Test func ignoresNotificationsFromElsewhere() {
        #expect(NotificationPayload(userInfo: ["aps": ["alert": "Hi"]]) == nil)
    }

    @Test func namesTheCategoryAfterTheNotification() {
        let category = NotificationCategories.category(for: notification.payload)
        #expect(category.identifier == "hobwork.n_1")
        #expect(category.actions.map(\.identifier) == ["reorder", "ignore"])
        #expect(category.actions.map(\.title) == ["Reorder", "Ignore"])
    }

    @Test func turnsActionsIntoEvents() {
        let response = Notifier.response(to: notification.payload, actionIdentifier: "reorder")
        #expect(response == Notifier.Response(
            event: DeviceEvent(capability: "notifications", name: "action", data: .object([
                "id": .string("n_1"),
                "action": .string("reorder"),
            ])),
            path: nil
        ))
    }

    @Test func opensTheProjectOnTap() {
        let response = Notifier.response(to: notification.payload, actionIdentifier: UNNotificationDefaultActionIdentifier)
        #expect(response == Notifier.Response(event: nil, path: "/projects/filament"))
    }

    @Test func decodesDeliveryOptions() throws {
        let args = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"id":"n_3","project":"filament","title":"Gojira stopped","actions":[{"id":"claim","title":"I'm on it"},
          {"id":"ranOut","title":"Spool ran out","foreground":true,"destructive":true,"open":"/tray/3"}],
         "interruptionLevel":"timeSensitive","sound":"none","thread":"filament/printer","open":"/print/problem","revision":3,"update":true}
        """#.utf8))
        let decoded = try args.decode(as: HobworkNotification.self)
        #expect(decoded.level == .timeSensitive)
        #expect(decoded.thread == "filament/printer")
        #expect(decoded.update == true)
        #expect(decoded.payload == NotificationPayload(
            id: "n_3",
            project: "filament",
            actions: [
                NotificationAction(id: "claim", title: "I'm on it"),
                NotificationAction(id: "ranOut", title: "Spool ran out", foreground: true, destructive: true, open: "/tray/3"),
            ],
            open: "/print/problem",
            revision: 3
        ))
        #expect(HobworkNotification(id: "n", title: "Hi", interruptionLevel: "passive").level == .passive)
        #expect(notification.level == .active)
    }

    @Test func actionsCarryTheirOptions() {
        let payload = NotificationPayload(id: "n_3", project: "filament", actions: [
            NotificationAction(id: "claim", title: "I'm on it"),
            NotificationAction(id: "end", title: "End the run", destructive: true),
            NotificationAction(id: "pick", title: "Pick", foreground: true, open: "/tray/3"),
        ])
        let category = NotificationCategories.category(for: payload)
        #expect(category.actions.map(\.options) == [[], [.destructive], [.foreground]])
    }

    @Test func opensTheHobAtThePathTheNotificationNames() {
        let payload = NotificationPayload(id: "n_3", project: "filament", actions: [
            NotificationAction(id: "claim", title: "I'm on it"),
            NotificationAction(id: "pick", title: "Pick", foreground: true, open: "/tray/3"),
            NotificationAction(id: "home", title: "Open", foreground: true),
        ], open: "/print/problem")
        #expect(Notifier.response(to: payload, actionIdentifier: UNNotificationDefaultActionIdentifier)?.path == "/p/filament/print/problem")
        #expect(Notifier.response(to: payload, actionIdentifier: "claim")?.path == nil)
        let pick = Notifier.response(to: payload, actionIdentifier: "pick")
        #expect(pick?.path == "/p/filament/tray/3")
        #expect(pick?.event?.data == .object(["id": .string("n_3"), "action": .string("pick")]))
        #expect(Notifier.response(to: payload, actionIdentifier: "home")?.path == "/projects/filament")
    }

    @Test func handledKeysTellRevisionsApart() {
        #expect(NotificationPayload.handledKey(id: "n", revision: nil) == "n")
        #expect(NotificationPayload.handledKey(id: "n", revision: 1) == "n")
        #expect(NotificationPayload.handledKey(id: "n", revision: 4) == "n#4")
    }

    @Test func ignoresDismissalsAndOtherNotifications() {
        #expect(Notifier.response(to: notification.payload, actionIdentifier: UNNotificationDismissActionIdentifier) == nil)
        #expect(Notifier.response(to: nil, actionIdentifier: "reorder") == nil)
    }
}

@MainActor
struct EventQueueTests {
    @Test func survivesRelaunches() throws {
        let defaults = try #require(UserDefaults(suiteName: "EventQueueTests"))
        defaults.removePersistentDomain(forName: "EventQueueTests")
        let event = DeviceEvent(capability: "notifications", name: "action", data: .object(["id": .string("n1")]))
        StoredEventQueue(defaults: defaults).append(event)

        let reloaded = StoredEventQueue(defaults: defaults)
        #expect(reloaded.events == [event])
        reloaded.removeFirst()
        #expect(StoredEventQueue(defaults: defaults).events.isEmpty)
    }

    @Test func dropsTheOldestPastTheLimit() throws {
        let defaults = try #require(UserDefaults(suiteName: "EventQueueLimitTests"))
        defaults.removePersistentDomain(forName: "EventQueueLimitTests")
        let queue = StoredEventQueue(defaults: defaults)
        for index in 0 ..< StoredEventQueue.limit + 5 {
            queue.append(DeviceEvent(capability: "c", name: "n", data: .number(Double(index))))
        }
        #expect(queue.events.count == StoredEventQueue.limit)
        #expect(queue.events.first?.data == .number(5))
    }
}
