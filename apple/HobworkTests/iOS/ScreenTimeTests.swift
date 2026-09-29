import Foundation
import Testing
@testable import Hobwork

struct ScreenTimePlanTests {
    let calendar = utcCalendar

    @Test func endsTimedBlocksAtUntil() throws {
        let now = isoDate("2026-05-04T07:00:00Z")
        let activity = try ScreenTimePlan.block(set: "social", until: isoDate("2026-05-04T21:00:00Z"), now: now, calendar: calendar)
        #expect(activity.name.rawValue == "block.social")
        #expect(activity.start == DateComponents(year: 2026, month: 5, day: 4, hour: 7, minute: 0, second: 0))
        #expect(activity.end == DateComponents(year: 2026, month: 5, day: 4, hour: 21, minute: 0, second: 0))
        #expect(!activity.repeats)
    }

    @Test func startsShortBlocksFifteenMinutesBeforeUntil() throws {
        let now = isoDate("2026-05-04T07:00:00Z")
        let activity = try ScreenTimePlan.block(set: "social", until: isoDate("2026-05-04T07:05:00Z"), now: now, calendar: calendar)
        #expect(activity.start == DateComponents(year: 2026, month: 5, day: 4, hour: 6, minute: 50, second: 0))
        #expect(throws: ScreenTimePlanError.untilInThePast) {
            try ScreenTimePlan.block(set: "social", until: now, now: now, calendar: calendar)
        }
    }

    @Test func measuresIntervalsAcrossMidnight() {
        #expect(ScreenTimePlan.length(from: TimeOfDay(hour: 22, minute: 0), to: TimeOfDay(hour: 7, minute: 0)) == 9 * 60)
        #expect(ScreenTimePlan.length(from: TimeOfDay(hour: 9, minute: 0), to: TimeOfDay(hour: 9, minute: 14)) == 14)
    }

    @Test func refusesSchedulesShorterThanFifteenMinutes() throws {
        let short = ScreenTimeSchedule(name: "s", set: "social", start: TimeOfDay(hour: 9, minute: 0), end: TimeOfDay(hour: 9, minute: 14))
        #expect(throws: ScreenTimePlanError.intervalTooShort) { try ScreenTimePlan.activities(for: short) }
        let empty = ScreenTimeSchedule(name: "s", set: "social", start: TimeOfDay(hour: 9, minute: 0), end: TimeOfDay(hour: 9, minute: 0))
        #expect(throws: ScreenTimePlanError.intervalTooShort) { try ScreenTimePlan.activities(for: empty) }
        let exact = ScreenTimeSchedule(name: "s", set: "social", start: TimeOfDay(hour: 23, minute: 50), end: TimeOfDay(hour: 0, minute: 5))
        #expect(try ScreenTimePlan.activities(for: exact).count == 1)
    }

    @Test func repeatsDailySchedules() throws {
        let schedule = ScreenTimeSchedule(name: "bedtime", set: "social", start: TimeOfDay(hour: 22, minute: 0), end: TimeOfDay(hour: 7, minute: 0))
        let activities = try ScreenTimePlan.activities(for: schedule)
        #expect(activities == [PlannedActivity(
            name: .schedule(name: "bedtime", day: nil),
            start: DateComponents(hour: 22, minute: 0),
            end: DateComponents(hour: 7, minute: 0),
            repeats: true
        )])
    }

    @Test func splitsWeeklySchedulesByDayAndEndsOvernightOnesTheNextDay() throws {
        let schedule = ScreenTimeSchedule(
            name: "school", set: "games", start: TimeOfDay(hour: 21, minute: 0), end: TimeOfDay(hour: 6, minute: 30), days: [.fri, .sun]
        )
        let activities = try ScreenTimePlan.activities(for: schedule)
        #expect(activities.map(\.name.rawValue) == ["schedule.school.fri", "schedule.school.sun"])
        #expect(activities[0].start == DateComponents(hour: 21, minute: 0, weekday: 6))
        #expect(activities[0].end == DateComponents(hour: 6, minute: 30, weekday: 7))
        #expect(activities[1].start.weekday == 1)
        #expect(activities[1].end.weekday == 2)

        let daytime = ScreenTimeSchedule(name: "work", set: "games", start: TimeOfDay(hour: 9, minute: 0), end: TimeOfDay(hour: 17, minute: 0), days: [.mon])
        let day = try ScreenTimePlan.activities(for: daytime)
        #expect(day[0].start.weekday == 2)
        #expect(day[0].end.weekday == 2)
    }

    @Test func limitsWatchTheWholeDay() {
        let limit = ScreenTimeLimit(name: "daily", set: "games", minutes: 45, days: [.sat])
        let activities = ScreenTimePlan.activities(for: limit)
        #expect(activities == [PlannedActivity(
            name: .limit(name: "daily", day: .sat),
            start: DateComponents(hour: 0, minute: 0, weekday: 7),
            end: DateComponents(hour: 23, minute: 59, weekday: 7),
            repeats: true,
            threshold: DateComponents(minute: 45),
            set: "games"
        )])
        #expect(ScreenTimePlan.activities(for: ScreenTimeLimit(name: "d", set: "g", minutes: 5)).map(\.name.rawValue) == ["limit.d"])
    }

    @Test func knowsWhenASchedulesIsActive() {
        let overnight = ScreenTimeSchedule(name: "b", set: "s", start: TimeOfDay(hour: 22, minute: 0), end: TimeOfDay(hour: 7, minute: 0), days: [.mon])
        #expect(ScreenTimePlan.isActive(overnight, at: isoDate("2026-05-04T23:00:00Z"), calendar: calendar))
        #expect(ScreenTimePlan.isActive(overnight, at: isoDate("2026-05-05T06:59:00Z"), calendar: calendar))
        #expect(!ScreenTimePlan.isActive(overnight, at: isoDate("2026-05-05T07:00:00Z"), calendar: calendar))
        #expect(!ScreenTimePlan.isActive(overnight, at: isoDate("2026-05-04T06:00:00Z"), calendar: calendar))
        #expect(!ScreenTimePlan.isActive(overnight, at: isoDate("2026-05-05T23:00:00Z"), calendar: calendar))

        let daily = ScreenTimeSchedule(name: "w", set: "s", start: TimeOfDay(hour: 9, minute: 0), end: TimeOfDay(hour: 17, minute: 0))
        #expect(ScreenTimePlan.isActive(daily, at: isoDate("2026-05-09T09:00:00Z"), calendar: calendar))
        #expect(!ScreenTimePlan.isActive(daily, at: isoDate("2026-05-09T17:00:00Z"), calendar: calendar))
    }

    @Test func roundTripsActivityNames() {
        for name in [ActivityName.block(set: "social"), .schedule(name: "bed-time", day: nil), .schedule(name: "b", day: .wed), .limit(name: "l", day: .sun)] {
            #expect(ActivityName(rawValue: name.rawValue) == name)
        }
        #expect(ActivityName(rawValue: "block.a.mon") == nil)
        #expect(ActivityName(rawValue: "schedule.a.funday") == nil)
        #expect(ActivityName(rawValue: "other.a") == nil)
        #expect(ActivityName.schedule(name: "b", day: .wed).store == "schedule.b")
        #expect(ActivityName.block(set: "social").store == "social")
    }
}

struct MonitorTests {
    let state = ScreenTimeState(
        sets: [AppSet(name: "social", selection: Data("s".utf8), apps: 2, categories: 0, sites: 1)],
        blocks: [ScreenTimeBlock(set: "social", until: isoDate("2026-05-04T21:00:00Z"))],
        schedules: [ScreenTimeSchedule(name: "bedtime", set: "social", start: TimeOfDay(hour: 22, minute: 0), end: TimeOfDay(hour: 7, minute: 0))],
        limits: [ScreenTimeLimit(name: "daily", set: "social", minutes: 30)]
    )

    @Test func shieldsAndLiftsSchedules() {
        #expect(ScreenTimePlan.actions(for: .intervalStart, activity: "schedule.bedtime.mon", state: state)
            == [.shield(store: "schedule.bedtime", set: "social")])
        #expect(ScreenTimePlan.actions(for: .intervalEnd, activity: "schedule.bedtime", state: state) == [.clear(store: "schedule.bedtime")])
        #expect(ScreenTimePlan.actions(for: .intervalStart, activity: "schedule.removed", state: state) == [])
    }

    @Test func endsTimedBlocks() {
        #expect(ScreenTimePlan.actions(for: .intervalStart, activity: "block.social", state: state) == [])
        #expect(ScreenTimePlan.actions(for: .intervalEnd, activity: "block.social", state: state)
            == [.clear(store: "social"), .endBlock(set: "social")])
    }

    @Test func shieldsLimitsUntilTheDayEnds() {
        #expect(ScreenTimePlan.actions(for: .threshold, activity: "limit.daily", state: state)
            == [.shield(store: "limit.daily", set: "social"), .limitReached(name: "daily")])
        #expect(ScreenTimePlan.actions(for: .intervalEnd, activity: "limit.daily", state: state)
            == [.clear(store: "limit.daily"), .resetLimit(name: "daily")])
        #expect(ScreenTimePlan.actions(for: .intervalStart, activity: "limit.daily.tue", state: state)
            == [.clear(store: "limit.daily"), .resetLimit(name: "daily")])
    }

    @Test func performsActions() {
        let shields = FakeShields()
        var state = state
        let now = isoDate("2026-05-04T15:00:00Z")
        ScreenTimePlan.perform(
            [.shield(store: "limit.daily", set: "social"), .limitReached(name: "daily"), .clear(store: "social"), .endBlock(set: "social")],
            shields: shields, state: &state, now: now, calendar: utcCalendar
        )
        #expect(shields.log == ["shield limit.daily", "clear social"])
        #expect(shields.shielded["limit.daily"] == Data("s".utf8))
        #expect(state.limits[0].reachedOn == "2026-05-04")
        #expect(state.blocks.isEmpty)

        ScreenTimePlan.perform([.resetLimit(name: "daily")], shields: shields, state: &state, now: now)
        #expect(state.limits[0].reachedOn == nil)
    }
}

@MainActor
struct ScreenTimeCapabilityTests {
    let shields = FakeShields()
    let monitoring = FakeActivityMonitoring()
    let file = temporaryFile(ScreenTimeState())
    let now = isoDate("2026-05-04T12:00:00Z")
    let selection = Data("tokens".utf8)

    init() {
        let selection = selection
        file.update { $0.sets = [AppSet(name: "social", selection: selection, apps: 3, categories: 1, sites: 0)] }
    }

    func makeCapability(authorized: Bool = true) -> ScreenTimeCapability {
        let now = now
        return ScreenTimeCapability(
            isAuthorized: { authorized },
            shields: shields, monitoring: monitoring, file: file, now: { now }, calendar: utcCalendar
        )
    }

    @Test func listsSetsWithCounts() async throws {
        #expect(try await makeCapability().handle(method: "sets", args: nil)
            == json(#"[{"name":"social","apps":3,"categories":1,"sites":0}]"#))
    }

    @Test func blocksUntilATime() async throws {
        let capability = makeCapability()
        _ = try await capability.handle(method: "block", args: json(#"{"set":"social","until":"2026-05-04T21:00:00Z"}"#))
        #expect(shields.shielded["social"] == selection)
        #expect(monitoring.started["block.social"]?.end.hour == 21)
        #expect(try await capability.handle(method: "status", args: nil)
            == json(#"{"blocked":[{"set":"social","until":"2026-05-04T21:00:00Z"}],"schedules":[],"limits":[]}"#))

        _ = try await capability.handle(method: "unblock", args: json(#"{"set":"social"}"#))
        #expect(shields.shielded.isEmpty)
        #expect(monitoring.started.isEmpty)
        #expect(file.read().blocks.isEmpty)
    }

    @Test func blocksWithoutEndStopTheOldTimer() async throws {
        let capability = makeCapability()
        _ = try await capability.handle(method: "block", args: json(#"{"set":"social","until":"2026-05-04T21:00:00Z"}"#))
        _ = try await capability.handle(method: "block", args: json(#"{"set":"social"}"#))
        #expect(monitoring.started.isEmpty)
        #expect(file.read().blocks == [ScreenTimeBlock(set: "social", until: nil)])
    }

    @Test func refusesUnknownSets() async {
        await #expect(throws: CallError(code: "unknown_set", message: "There is no app set named work on this device. Create it in the Hobwork app's settings.")) {
            try await makeCapability().handle(method: "block", args: json(#"{"set":"work"}"#))
        }
        await #expect {
            try await makeCapability().handle(method: "unblock", args: json(#"{"set":"work"}"#))
        } throws: { ($0 as? CallError)?.code == "unknown_set" }
    }

    @Test func schedulesAndShieldsRightAwayInsideTheInterval() async throws {
        let capability = makeCapability()
        _ = try await capability.handle(method: "schedule", args: json(#"{"name":"lunch","set":"social","start":"11:30","end":"13:00","days":["mon","tue"]}"#))
        #expect(monitoring.activities == ["schedule.lunch.mon", "schedule.lunch.tue"])
        #expect(shields.shielded["schedule.lunch"] == selection)

        _ = try await capability.handle(method: "schedule", args: json(#"{"name":"lunch","set":"social","start":"14:00","end":"15:00"}"#))
        #expect(monitoring.activities == ["schedule.lunch"])
        #expect(shields.shielded["schedule.lunch"] == nil)
        #expect(file.read().schedules.count == 1)

        _ = try await capability.handle(method: "removeSchedule", args: json(#"{"name":"lunch"}"#))
        #expect(monitoring.activities.isEmpty)
        #expect(file.read().schedules.isEmpty)
    }

    @Test func removingAScheduleLeavesOthersWithTheSamePrefix() async throws {
        let capability = makeCapability()
        _ = try await capability.handle(method: "schedule", args: json(#"{"name":"a","set":"social","start":"20:00","end":"21:00"}"#))
        _ = try await capability.handle(method: "schedule", args: json(#"{"name":"a-b","set":"social","start":"20:00","end":"21:00"}"#))
        _ = try await capability.handle(method: "removeSchedule", args: json(#"{"name":"a"}"#))
        #expect(monitoring.activities == ["schedule.a-b"])
    }

    @Test func refusesShortSchedules() async {
        await #expect {
            try await makeCapability().handle(method: "schedule", args: json(#"{"name":"x","set":"social","start":"10:00","end":"10:10"}"#))
        } throws: { ($0 as? CallError)?.code == "interval_too_short" }
        #expect(monitoring.started.isEmpty)
    }

    @Test func setsDailyLimitsAndReportsWhenReached() async throws {
        let capability = makeCapability()
        _ = try await capability.handle(method: "limit", args: json(#"{"name":"daily","set":"social","minutes":30}"#))
        #expect(monitoring.started["limit.daily"]?.threshold == DateComponents(minute: 30))
        #expect(monitoring.selections["limit.daily"] == selection)

        file.update { $0.limits[0].reachedOn = "2026-05-04" }
        let status = try await capability.handle(method: "status", args: nil)
        #expect(status["limits"] == json(#"[{"name":"daily","set":"social","minutes":30,"reached":true}]"#))
        file.update { $0.limits[0].reachedOn = "2026-05-03" }
        #expect(try await capability.handle(method: "status", args: nil)["limits"]?.arrayValue?.first?["reached"] == .bool(false))

        _ = try await capability.handle(method: "removeLimit", args: json(#"{"name":"daily"}"#))
        #expect(monitoring.started.isEmpty)
        #expect(file.read().limits.isEmpty)
    }

    @Test func mapsTooManyActivitiesToLimitReached() async {
        monitoring.failure = .tooManyActivities
        await #expect {
            try await makeCapability().handle(method: "limit", args: json(#"{"name":"daily","set":"social","minutes":30}"#))
        } throws: { ($0 as? CallError)?.code == "limit_reached" }
    }

    @Test func dropsEndedBlocksFromStatus() async throws {
        file.update { $0.blocks = [ScreenTimeBlock(set: "social", until: isoDate("2026-05-04T11:00:00Z"))] }
        #expect(try await makeCapability().handle(method: "status", args: nil)["blocked"] == .array([]))
    }

    @Test func needsPermission() async {
        await #expect {
            try await makeCapability(authorized: false).handle(method: "sets", args: nil)
        } throws: { ($0 as? CallError)?.code == "not_authorized" }
    }
}
