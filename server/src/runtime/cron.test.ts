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
