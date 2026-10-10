import { expect, test } from 'vitest'
import { fromLocalTime, isTimeZone, localTime, zonedInstant } from '../src/index.ts'

test('localTime gives the wall-clock time in a zone or a person’s zone', () => {
  const at = new Date('2026-03-29T00:30:00Z')
  expect(localTime('Europe/Istanbul', at)).toEqual({
    timeZone: 'Europe/Istanbul',
    year: 2026,
    month: 3,
    day: 29,
    hour: 3,
    minute: 30,
    second: 0,
    weekday: 'sun',
    date: '2026-03-29',
    time: '03:30',
    offsetMinutes: 180,
  })
  expect(localTime({ timeZone: 'America/New_York' }, at)).toMatchObject({
    date: '2026-03-28',
    time: '20:30',
    weekday: 'sat',
    offsetMinutes: -240,
  })
})

test('fromLocalTime finds the instant of a wall-clock time, across DST changes', () => {
  expect(fromLocalTime('Europe/Berlin', '2026-01-15', '08:30')?.toISOString()).toBe('2026-01-15T07:30:00.000Z')
  expect(fromLocalTime('Europe/Berlin', '2026-07-15', '08:30')?.toISOString()).toBe('2026-07-15T06:30:00.000Z')
  // 02:30 does not happen on the night clocks go forward.
  expect(fromLocalTime('Europe/Berlin', '2026-03-29', '02:30')).toBeUndefined()
  // 02:30 happens twice when they go back; the first one counts.
  expect(fromLocalTime('Europe/Berlin', '2026-10-25', '02:30')?.toISOString()).toBe('2026-10-25T00:30:00.000Z')
  expect(zonedInstant('UTC', { year: 2026, month: 1, day: 1 })?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  expect(() => fromLocalTime('UTC', '2026-1-1', '8:00')).toThrow(RangeError)
})

test('isTimeZone knows IANA zones', () => {
  expect(isTimeZone('Europe/Istanbul')).toBe(true)
  expect(isTimeZone('UTC')).toBe(true)
  expect(isTimeZone('Mars/Olympus')).toBe(false)
  expect(isTimeZone('')).toBe(false)
  expect(isTimeZone(42)).toBe(false)
})
