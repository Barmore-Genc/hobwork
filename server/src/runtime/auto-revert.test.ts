import { expect, test } from 'vitest'
import { createDeployHealth } from './auto-revert.ts'

const policy = { windowMs: 60_000, minFailures: 3, minFailingMs: 10_000 }
const MINUTE = 60_000

test('reverts after enough failures over enough time with no success', () => {
  const health = createDeployHealth(policy, 0)
  expect(health.record(false, 1_000)).toBeUndefined()
  expect(health.record(false, 2_000)).toBeUndefined()
  // Three failures, but within 1s of each other.
  expect(health.record(false, 3_000)).toBeUndefined()
  expect(health.record(false, 11_000)).toBe('4 invocations failed over 10s after the deploy and none succeeded')
  // Asks only once.
  expect(health.record(false, 12_000)).toBeUndefined()
})

test('one success ends the watch', () => {
  const health = createDeployHealth(policy, 0)
  health.record(false, 1_000)
  health.record(true, 2_000)
  for (let t = 3_000; t < 30_000; t += 1_000) expect(health.record(false, t)).toBeUndefined()
})

test('failures after the window do not count', () => {
  const health = createDeployHealth(policy, 0)
  health.record(false, 1_000)
  health.record(false, 2_000)
  expect(health.record(false, 2 * MINUTE)).toBeUndefined()
  expect(health.record(false, 2 * MINUTE + 1)).toBeUndefined()
})
