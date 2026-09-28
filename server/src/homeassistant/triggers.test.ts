import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createHomeAssistant, type HomeAssistant, type TriggerVariables } from './client.ts'
import { startFakeHomeAssistant, type FakeHomeAssistant } from './fake-ha.ts'
import { createTriggerRegistry, type TriggerRegistry } from './triggers.ts'

let fake: FakeHomeAssistant
let ha: HomeAssistant
let registry: TriggerRegistry
let invocations: { project: string; name: string; variables: TriggerVariables }[]
const silent = { info() {}, warn() {}, error() {} }

const button = { trigger: 'device', domain: 'zha', device_id: 'abc', type: 'remote_button_short_press' }
const motion = { trigger: 'state', entity_id: 'binary_sensor.hall', to: 'on' }

beforeEach(async () => {
  invocations = []
  fake = await startFakeHomeAssistant()
  ha = createHomeAssistant({
    connection: () => ({ url: fake.url, token: fake.token }),
    logger: silent,
    requestTimeoutMs: 1000,
    reconnectDelayMs: { initial: 20, max: 100 },
  })
  ha.start()
  await ha.waitUntilConnected()
  registry = createTriggerRegistry({
    ha,
    invoke: (project, name, variables) => void invocations.push({ project, name, variables }),
    logger: silent,
  })
})

afterEach(async () => {
  ha.stop()
  await fake.close()
})

test('subscribes Home Assistant triggers and invokes the handler when one fires', async () => {
  const results = await registry.syncProjectTriggers('lights', {
    'desk-button': { homeassistant: button, handler: 'src/desk-button.ts' },
    other: { handler: 'src/other.ts' },
  })
  expect(results).toEqual([{ name: 'desk-button', status: 'subscribed' }])
  expect(fake.subscriptions.map((s) => s.trigger)).toEqual([button])

  fake.fire({ trigger: { platform: 'device', device_id: 'abc' } })
  await vi.waitFor(() => expect(invocations).toHaveLength(1))
  expect(invocations[0]).toEqual({
    project: 'lights',
    name: 'desk-button',
    variables: { trigger: { platform: 'device', device_id: 'abc' } },
  })
})

test('diffs against the previous sync', async () => {
  await registry.syncProjectTriggers('lights', {
    'desk-button': { homeassistant: button, handler: 'a.ts' },
    motion: { homeassistant: motion, handler: 'b.ts' },
  })
  const buttonSubscription = fake.subscriptions.find((s) => (s.trigger as { trigger: string }).trigger === 'device')

  const changedMotion = { ...motion, to: 'off' }
  const results = await registry.syncProjectTriggers('lights', {
    // Same trigger with keys in another order counts as unchanged.
    'desk-button': { homeassistant: Object.fromEntries(Object.entries(button).reverse()), handler: 'a.ts' },
    motion: { homeassistant: changedMotion, handler: 'b.ts' },
    extra: { homeassistant: { trigger: 'event', event_type: 'x' }, handler: 'c.ts' },
  })
  expect(results).toEqual([
    { name: 'desk-button', status: 'unchanged' },
    { name: 'motion', status: 'subscribed' },
    { name: 'extra', status: 'subscribed' },
  ])
  expect(fake.subscriptions).toHaveLength(3)
  expect(fake.subscriptions).toContain(buttonSubscription)
  expect(fake.subscriptions.map((s) => s.trigger)).toContainEqual(changedMotion)
  expect(fake.subscriptions.map((s) => s.trigger)).not.toContainEqual(motion)

  expect(await registry.syncProjectTriggers('lights', { motion: { homeassistant: changedMotion } })).toEqual([
    { name: 'desk-button', status: 'removed' },
    { name: 'extra', status: 'removed' },
    { name: 'motion', status: 'unchanged' },
  ])
  expect(registry.active('lights')).toEqual(['motion'])
})

test('keeps projects apart and removes a project', async () => {
  await registry.syncProjectTriggers('a', { t: { homeassistant: button } })
  await registry.syncProjectTriggers('b', { t: { homeassistant: button } })
  expect(fake.subscriptions).toHaveLength(2)

  fake.fire({ trigger: {} })
  await vi.waitFor(() => expect(invocations).toHaveLength(2))
  expect(invocations.map((i) => i.project).sort()).toEqual(['a', 'b'])

  expect(await registry.removeProject('a')).toEqual([{ name: 't', status: 'removed' }])
  expect(fake.subscriptions).toHaveLength(1)
  expect(registry.active('a')).toEqual([])
  expect(registry.active('b')).toEqual(['t'])
})

test('reports triggers Home Assistant refuses and retries them on the next sync', async () => {
  const results = await registry.syncProjectTriggers('p', {
    bad: { homeassistant: { trigger: 'bogus' } },
    good: { homeassistant: motion },
  })
  expect(results).toEqual([
    { name: 'bad', status: 'failed', error: "Invalid trigger 'bogus' specified" },
    { name: 'good', status: 'subscribed' },
  ])
  expect(registry.active('p')).toEqual(['good'])
})

test('overlapping syncs apply in order', async () => {
  const first = registry.syncProjectTriggers('p', { a: { homeassistant: button } })
  const second = registry.syncProjectTriggers('p', { b: { homeassistant: motion } })
  await Promise.all([first, second])
  expect(registry.active('p')).toEqual(['b'])
  expect(fake.subscriptions.map((s) => s.trigger)).toEqual([motion])
})

test('marks triggers pending while Home Assistant is down and subscribes them on reconnect', async () => {
  const port = Number(new URL(fake.url).port)
  await fake.close()
  await vi.waitFor(() => expect(ha.status).not.toBe('connected'))
  expect(await registry.syncProjectTriggers('p', { t: { homeassistant: button } })).toEqual([
    { name: 't', status: 'pending' },
  ])
  fake = await startFakeHomeAssistant({ port })
  await vi.waitFor(() => expect(fake.subscriptions).toHaveLength(1))
  fake.fire({ trigger: {} })
  await vi.waitFor(() => expect(invocations).toHaveLength(1))
})

test('a failing invoke does not stop later triggers', async () => {
  let calls = 0
  registry = createTriggerRegistry({
    ha,
    invoke: async () => {
      calls++
      throw new Error('VM did not start')
    },
    logger: silent,
  })
  await registry.syncProjectTriggers('p', { t: { homeassistant: button } })
  fake.fire({})
  fake.fire({})
  await vi.waitFor(() => expect(calls).toBe(2))
})
