import AlarmKit
import Foundation
import Testing
@testable import Hobwork

struct AlarmScreenTests {
    let id = UUID(uuidString: "6a1d3b3e-8a55-4f4c-9d6f-0a2f5b0c7e11")!
    let now = isoDate("2026-05-04T07:00:00Z")

    var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_GB")
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    @Test func mapsTimersAndAlarms() {
        let timer = AlarmItem(id: id, state: .countdown, schedule: nil, duration: 240, title: "Tea", progress: nil, now: now)
        #expect(timer.kind == .timer)
        #expect(timer.title == "Tea")
        #expect(timer.status == .running(endsAt: nil))
        #expect(timer.detailText(calendar: calendar) == "4:00")

        let schedule = Alarm.Schedule.relative(.init(time: .init(hour: 6, minute: 45), repeats: .weekly([.friday, .monday])))
        let alarm = AlarmItem(id: id, state: .scheduled, schedule: schedule, duration: nil, title: nil, progress: nil, now: now)
        #expect(alarm.kind == .alarm)
        #expect(alarm.title == "Alarm")
        #expect(alarm.when == .time(TimeOfDay(hour: 6, minute: 45), days: [.mon, .fri]))
        #expect(alarm.detailText(calendar: calendar) == "06:45, Mon, Fri")
    }

    @Test func describesWhenAlarmsRing() {
        func detail(_ when: AlarmItem.When) -> String? {
            AlarmItem(id: id, title: "x", kind: .alarm, status: .scheduled, when: when).detailText(calendar: calendar)
        }
        #expect(detail(.time(TimeOfDay(hour: 7, minute: 0), days: nil)) == "Rings at 07:00")
        #expect(detail(.time(TimeOfDay(hour: 7, minute: 0), days: Weekday.allCases)) == "07:00, every day")
        #expect(detail(.time(TimeOfDay(hour: 7, minute: 0), days: [.mon, .tue, .wed, .thu, .fri])) == "07:00, weekdays")
        #expect(detail(.time(TimeOfDay(hour: 9, minute: 30), days: [.sun, .sat])) == "09:30, weekends")
        #expect(detail(.at(isoDate("2026-05-04T19:00:00Z")))?.hasPrefix("Rings Mon") == true)
    }

    @Test func readsTheCountdownInTheLightOfTheAlarmState() {
        let fire = now.addingTimeInterval(90)
        #expect(AlarmItem.status(.countdown, progress: .running(fireDate: fire), now: now) == .running(endsAt: fire))
        // Paused by the app, before the Live Activity caught up.
        #expect(AlarmItem.status(.paused, progress: .running(fireDate: fire), now: now) == .paused(remaining: 90))
        #expect(AlarmItem.status(.paused, progress: .running(fireDate: now.addingTimeInterval(-5)), now: now) == .paused(remaining: 0))
        // Resumed by the app, before the Live Activity caught up.
        #expect(AlarmItem.status(.countdown, progress: .paused(remaining: 30), now: now) == .running(endsAt: now.addingTimeInterval(30)))
        #expect(AlarmItem.status(.paused, progress: .paused(remaining: 30), now: now) == .paused(remaining: 30))
        #expect(AlarmItem.status(.paused, progress: nil, now: now) == .paused(remaining: nil))
        #expect(AlarmItem.status(.alerting, progress: nil, now: now) == .ringing)
        #expect(AlarmItem.status(.scheduled, progress: nil, now: now) == .scheduled)
    }

    @Test func offersActionsForEachState() {
        func actions(_ status: AlarmItem.Status) -> [AlarmItem.Action] {
            AlarmItem(id: id, title: "x", kind: .timer, status: status).actions
        }
        #expect(actions(.scheduled) == [.cancel])
        #expect(actions(.running(endsAt: nil)) == [.pause, .cancel])
        #expect(actions(.paused(remaining: 10)) == [.resume, .cancel])
        #expect(actions(.ringing) == [.stop])
    }

    @Test func showsWhatIsLeftOfPausedTimers() {
        let paused = AlarmItem(id: id, title: "Tea", kind: .timer, status: .paused(remaining: 200), duration: 240)
        #expect(paused.stateText == "Paused")
        #expect(paused.detailText(calendar: calendar) == "3:20 left")
        #expect(AlarmItem.durationText(3725) == "1:02:05")
    }

    @Test func listsRingingFirstThenTimersThenAlarms() {
        let items = [
            AlarmItem(id: UUID(), title: "Wake", kind: .alarm, status: .scheduled),
            AlarmItem(id: UUID(), title: "Tea", kind: .timer, status: .running(endsAt: nil)),
            AlarmItem(id: UUID(), title: "Bins", kind: .alarm, status: .ringing),
            AlarmItem(id: UUID(), title: "Bread", kind: .alarm, status: .scheduled),
        ]
        #expect(AlarmItem.sorted(items).map(\.title) == ["Bins", "Tea", "Bread", "Wake"])
    }

    @Test func opensTheAlarmsScreenAfterAlarmsCommands() {
        let timer = DeviceCommand(id: .string("1"), capability: "alarms", method: "timer", foreground: true)
        let ok = CommandOutcome(.success(.object(["id": .string("x")])))
        #expect(AlarmFollowUp.after(timer, outcome: ok, deviceName: "iPad") == AlarmFollowUp())
        #expect(AlarmFollowUp.after(timer, outcome: nil, deviceName: "iPad") == AlarmFollowUp())
        let list = DeviceCommand(id: .string("2"), capability: "alarms", method: "list")
        #expect(AlarmFollowUp.after(list, outcome: CommandOutcome(.success(.array([]))), deviceName: "iPad") == AlarmFollowUp())

        let nfc = DeviceCommand(id: .string("3"), capability: "nfc", method: "read", foreground: true)
        #expect(AlarmFollowUp.after(nfc, outcome: ok, deviceName: "iPad") == nil)
    }

    @Test func explainsFailedAlarmsCommands() {
        let timer = DeviceCommand(id: .string("1"), capability: "alarms", method: "timer")
        let denied = CommandOutcome(.failure(.notAuthorized("Alarms are not allowed")))
        let problem = AlarmFollowUp.after(timer, outcome: denied, deviceName: "iPad")?.problem
        #expect(problem == AlarmFollowUp.Problem(
            title: "Couldn't Start the Timer",
            message: "Hobwork isn't allowed to set alarms and timers on this iPad. Allow it in Settings.",
            opensSettings: true
        ))

        let set = DeviceCommand(id: .string("2"), capability: "alarms", method: "set")
        let full = CommandOutcome(.failure(CallError(code: "limit_reached", message: "Too many")))
        #expect(AlarmFollowUp.after(set, outcome: full, deviceName: "iPad")?.problem
            == AlarmFollowUp.Problem(title: "Couldn't Set the Alarm", message: "Too many", opensSettings: false))
    }
}
