import { createTestContext } from '@hobwork/sdk/testing'
import { afterEach, expect, test, vi } from 'vitest'
import greetingRoute from '../src/greeting-route.ts'
import { greeting } from '../src/greeting.ts'
import morningGreeting from '../src/morning-greeting.ts'

afterEach(() => {
  vi.useRealTimers()
})

test.each([
  [7, 'Good morning'],
  [13, 'Good afternoon'],
  [21, 'Good evening'],
])('greeting at %i:00', (hour, expected) => {
  expect(greeting(new Date(2026, 0, 1, hour))).toBe(expected)
})

test('route returns the greeting', async () => {
  vi.useFakeTimers({ now: new Date(2026, 0, 1, 9) })
  expect(await greetingRoute()).toEqual({ message: 'Good morning' })
})

test('cron logs the greeting', async () => {
  vi.useFakeTimers({ now: new Date(2026, 0, 1, 8) })
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  await morningGreeting(createTestContext({ log }))
  expect(log.info).toHaveBeenCalledWith('Good morning')
})
