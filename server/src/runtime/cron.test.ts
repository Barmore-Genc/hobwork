import { expect, test } from 'vitest'
import { CronError, nextRun, parseCron } from './cron.ts'

function next(expression: string, after: Date): Date | undefined {
  return nextRun(parseCron(expression), after)
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

test('parses fields with ranges, lists, steps and names', () => {
  const cron = parseCron('*/15 8-18/2 1,15 jan-mar MON-fri')
  expect([...cron.minutes]).toEqual([0, 15, 30, 45])
  expect([...cron.hours]).toEqual([8, 10, 12, 14, 16, 18])
  expect([...cron.daysOfMonth]).toEqual([1, 15])
  expect([...cron.months]).toEqual([1, 2, 3])
  expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5])
  expect(cron.anyDayOfMonth).toBe(false)
  expect(parseCron('0 0 * * 7').daysOfWeek).toEqual(new Set([0]))
  expect([...parseCron('5/20 * * * *').minutes]).toEqual([5, 25, 45])
})

test.each([
  ['0 6 * *', 'must have 5 fields'],
  ['60 * * * *', 'minute 60 is out of range'],
  ['* 24 * * *', 'hour 24 is out of range'],
  ['* * 0 * *', 'day of month 0 is out of range'],
  ['* * * foo *', '"foo" is not a valid month'],
  ['*/0 * * * *', 'not a valid step'],
  ['5-1 * * * *', 'goes backwards'],
])('rejects %s', (expression, message) => {
  expect(() => parseCron(expression)).toThrow(CronError)
  expect(() => parseCron(expression)).toThrow(message)
})

test('finds the next run strictly after the given time', () => {
  expect(next('0 6 * * *', at(2026, 3, 10, 5, 59))).toEqual(at(2026, 3, 10, 6, 0))
  expect(next('0 6 * * *', at(2026, 3, 10, 6, 0))).toEqual(at(2026, 3, 11, 6, 0))
  expect(next('* * * * *', new Date(2026, 2, 10, 6, 0, 30))).toEqual(at(2026, 3, 10, 6, 1))
  expect(next('30 23 31 12 *', at(2026, 3, 10))).toEqual(at(2026, 12, 31, 23, 30))
})

test('weekdays: 2026-03-14 is a Saturday', () => {
  expect(next('0 6 * * 1-5', at(2026, 3, 14, 12))).toEqual(at(2026, 3, 16, 6, 0))
})

test('a day matches either day field when both are restricted', () => {
  // The 20th, or any Monday: after Sat 14th comes Mon 16th.
  expect(next('0 0 20 * mon', at(2026, 3, 14))).toEqual(at(2026, 3, 16))
  // Only one restricted: both must match (every day in March is `*`).
  expect(next('0 0 * 3 mon', at(2026, 3, 14))).toEqual(at(2026, 3, 16))
})

test('leap days and impossible dates', () => {
  expect(next('0 0 29 2 *', at(2026, 3, 1))).toEqual(at(2028, 2, 29))
  expect(next('0 0 31 2 *', at(2026, 3, 1))).toBeUndefined()
})

test('runs in a given time zone, whatever the host zone', () => {
  const cron = parseCron('0 8 * * mon-fri')
  // Friday 2026-10-09 06:00 UTC is 09:00 in Istanbul, so the next run is Monday.
  expect(nextRun(cron, new Date('2026-10-09T06:00:00Z'), 'Europe/Istanbul')?.toISOString()).toBe('2026-10-12T05:00:00.000Z')
  expect(nextRun(cron, new Date('2026-10-09T06:00:00Z'), 'America/New_York')?.toISOString()).toBe('2026-10-09T12:00:00.000Z')
  expect(nextRun(parseCron('30 23 31 12 *'), new Date('2026-12-31T22:00:00Z'), 'Pacific/Auckland')?.toISOString()).toBe(
    '2027-12-31T10:30:00.000Z',
  )
  expect(nextRun(parseCron('0 0 31 2 *'), new Date('2026-03-01T00:00:00Z'), 'UTC')).toBeUndefined()
})

test('a zone skips times DST skips and runs repeated times once', () => {
  const cron = parseCron('30 2 * * *')
  // Clocks go forward in Berlin at 02:00 on 2026-03-29.
  expect(nextRun(cron, new Date('2026-03-28T12:00:00Z'), 'Europe/Berlin')?.toISOString()).toBe('2026-03-30T00:30:00.000Z')
  // They go back at 03:00 on 2026-10-25, so 02:30 happens twice.
  const first = nextRun(cron, new Date('2026-10-24T12:00:00Z'), 'Europe/Berlin')!
  expect(first.toISOString()).toBe('2026-10-25T00:30:00.000Z')
  expect(nextRun(cron, first, 'Europe/Berlin')?.toISOString()).toBe('2026-10-26T01:30:00.000Z')
  // During the second 02:00-03:00, the next minute is 03:00.
  expect(nextRun(parseCron('* * * * *'), new Date('2026-10-25T01:30:00Z'), 'Europe/Berlin')?.toISOString()).toBe(
    '2026-10-25T02:00:00.000Z',
  )
})
