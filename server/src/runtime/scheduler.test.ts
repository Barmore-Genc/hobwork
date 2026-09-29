import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createScheduler } from './scheduler.ts'

let fired: string[]
let scheduler: ReturnType<typeof createScheduler>

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 2, 10, 7, 58, 30) })
  fired = []
  scheduler = createScheduler((project, cron) => fired.push(`${project}/${cron}`))
})

afterEach(() => {
  scheduler.stop()
  vi.useRealTimers()
})

test('fires each cron at its times', async () => {
  scheduler.set('filament', {
    minutely: { schedule: '* * * * *' },
    eight: { schedule: '0 8 * * *' },
  })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(fired).toEqual(['filament/minutely'])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fired.sort()).toEqual(['filament/eight', 'filament/minutely', 'filament/minutely'])
  expect(scheduler.list('filament').find((c) => c.name === 'eight')?.next).toEqual(new Date(2026, 2, 11, 8, 0))
})

test('replacing and removing a project stops its old crons', async () => {
  scheduler.set('filament', { minutely: { schedule: '* * * * *' } })
  scheduler.set('filament', { hourly: { schedule: '0 * * * *' } })
  scheduler.set('alarms', { minutely: { schedule: '* * * * *' } })
  scheduler.remove('alarms')
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(fired).toEqual(['filament/hourly'])
})

test('reports invalid schedules and keeps the valid ones', async () => {
  const problems = scheduler.set('filament', {
    bad: { schedule: '61 * * * *' },
    never: { schedule: '0 0 30 2 *' },
    ok: { schedule: '* * * * *' },
  })
  expect(problems).toEqual([
    'cron "bad": minute 61 is out of range (0-59)',
    'cron "never": "0 0 30 2 *" never matches a date',
  ])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fired).toEqual(['filament/ok'])
})

test('waits through delays longer than one timer allows', async () => {
  scheduler.set('filament', { yearly: { schedule: '0 0 1 1 *' } })
  await vi.advanceTimersByTimeAsync(40 * 24 * 60 * 60_000)
  expect(fired).toEqual([])
  await vi.advanceTimersByTimeAsync(300 * 24 * 60 * 60_000)
  expect(fired).toEqual(['filament/yearly'])
})
