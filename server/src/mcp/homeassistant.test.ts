import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createHomeAssistant, type HomeAssistant } from '../homeassistant/client.ts'
import { startFakeHomeAssistant, type FakeHomeAssistant } from '../homeassistant/fake-ha.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

let fake: FakeHomeAssistant
let ha: HomeAssistant
let mcp: TestMcp
const silent = { info() {}, warn() {}, error() {} }

function device(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    name_by_user: null,
    manufacturer: 'IKEA',
    model: 'Remote',
    area_id: null,
    identifiers: [['zha', id]],
    disabled_by: null,
    ...extra,
  }
}

function state(entity_id: string, value: string, friendly_name: string) {
  return { entity_id, state: value, attributes: { friendly_name }, last_changed: '', last_updated: '' }
}

beforeEach(async () => {
  fake = await startFakeHomeAssistant()
  fake.responses.set('config/area_registry/list', () => [{ area_id: 'kitchen', name: 'Kitchen' }])
  fake.responses.set('config/device_registry/list', () => [
    device('d1', 'Desk button'),
    device('d2', 'Kitchen light', { manufacturer: 'Signify', area_id: 'kitchen', identifiers: [['hue', 'x']] }),
    device('d3', 'Old sensor', { disabled_by: 'user' }),
    ...Array.from({ length: 80 }, (_, i) => device(`bulk${i}`, `Bulk ${i}`)),
  ])
  fake.responses.set('get_states', () => [
    state('light.kitchen', 'on', 'Kitchen light'),
    state('sensor.desk_battery', '80', 'Desk battery'),
    state('input_boolean.guest_mode', 'off', 'Guest mode'),
  ])
  fake.responses.set('config/entity_registry/list', () => [
    { entity_id: 'light.kitchen', device_id: 'd2', area_id: null, platform: 'hue' },
    { entity_id: 'sensor.desk_battery', device_id: 'd1', area_id: null, platform: 'zha' },
  ])
  fake.responses.set('get_services', () => ({
    light: {
      turn_on: { name: 'Turn on', description: 'Turns on lights', fields: { brightness: {} }, target: {} },
      turn_off: { name: 'Turn off', description: 'Turns off lights', fields: {}, target: {} },
    },
    tts: { speak: { name: 'Speak', description: 'Speaks text', fields: { message: { required: true } } } },
  }))
  fake.responses.set('device_automation/trigger/list', (m) => [
    { platform: 'device', domain: 'zha', device_id: m.device_id, type: 'remote_button_short_press', subtype: 'turn_on' },
  ])
  ha = createHomeAssistant({
    connection: () => ({ url: fake.url, token: fake.token }),
    logger: silent,
    requestTimeoutMs: 1000,
  })
  ha.start()
  mcp = await startTestMcp({ homeAssistant: ha })
})

afterEach(async () => {
  await mcp.close()
  ha.stop()
  await fake.close()
})

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await mcp.call(name, args)
  expect(result.isError, textOf(result)).toBeFalsy()
  const body = textOf(result)
  return body.startsWith('{') || body.startsWith('[') ? JSON.parse(body) : body
}

test('lists devices with filters and paging', async () => {
  const all = await ok('ha_list_devices')
  expect(all.total).toBe(82)
  expect(all.items).toHaveLength(50)
  expect(all.next_offset).toBe(50)
  expect(all.items[0]).toEqual({
    id: 'd1',
    name: 'Desk button',
    manufacturer: 'IKEA',
    model: 'Remote',
    area: null,
    area_id: null,
    integrations: ['zha'],
  })

  expect((await ok('ha_list_devices', { area: 'kitchen' })).items.map((d: any) => d.id)).toEqual(['d2'])
  expect((await ok('ha_list_devices', { search: 'signify' })).items[0].area).toBe('Kitchen')
  expect((await ok('ha_list_devices', { integration: 'hue' })).total).toBe(1)
  expect((await ok('ha_list_devices', { search: 'old' })).total).toBe(0)
  expect((await ok('ha_list_devices', { search: 'old', include_disabled: true })).total).toBe(1)
  const last = await ok('ha_list_devices', { offset: 80 })
  expect(last.items).toHaveLength(2)
  expect(last.next_offset).toBeUndefined()
})

test('lists entities with state, device and area', async () => {
  const all = await ok('ha_list_entities')
  expect(all.items.map((e: any) => e.entity_id)).toEqual([
    'input_boolean.guest_mode',
    'light.kitchen',
    'sensor.desk_battery',
  ])
  expect(all.items[1]).toMatchObject({ name: 'Kitchen light', state: 'on', device_id: 'd2', area: 'Kitchen', platform: 'hue' })
  expect((await ok('ha_list_entities', { domain: 'sensor' })).total).toBe(1)
  expect((await ok('ha_list_entities', { device_id: 'd1' })).items[0].entity_id).toBe('sensor.desk_battery')
  expect((await ok('ha_list_entities', { area: 'Kitchen' })).total).toBe(1)
  expect((await ok('ha_list_entities', { search: 'guest' })).total).toBe(1)
})

test('gets the state of one entity', async () => {
  expect(await ok('ha_get_state', { entity_id: 'light.kitchen' })).toMatchObject({ state: 'on' })
  const missing = await mcp.call('ha_get_state', { entity_id: 'light.nope' })
  expect(missing.isError).toBe(true)
  expect(textOf(missing)).toContain('ha_list_entities')
})

test('lists services and shows one in full', async () => {
  const all = await ok('ha_list_services')
  expect(all.items.map((s: any) => s.service)).toEqual(['light.turn_off', 'light.turn_on', 'tts.speak'])
  expect(all.items[1]).toEqual({
    service: 'light.turn_on',
    name: 'Turn on',
    description: 'Turns on lights',
    fields: ['brightness'],
    takes_target: true,
  })
  expect((await ok('ha_list_services', { domain: 'tts' })).total).toBe(1)
  expect((await ok('ha_list_services', { search: 'speaks' })).items[0].service).toBe('tts.speak')
  expect(await ok('ha_list_services', { domain: 'tts', service: 'speak' })).toMatchObject({
    service: 'tts.speak',
    fields: { message: { required: true } },
  })
  expect((await mcp.call('ha_list_services', { service: 'speak' })).isError).toBe(true)
})

test('lists device triggers', async () => {
  expect(await ok('ha_list_device_triggers', { device_id: 'd1' })).toEqual([
    { platform: 'device', domain: 'zha', device_id: 'd1', type: 'remote_button_short_press', subtype: 'turn_on' },
  ])
})

test('ha_listen returns the variables of the first fire and unsubscribes', async () => {
  const trigger = { trigger: 'state', entity_id: 'input_boolean.guest_mode' }
  const listening = mcp.call('ha_listen', { trigger, timeout_seconds: 5 })
  await vi.waitFor(() => expect(fake.subscriptions).toHaveLength(1))
  expect(fake.subscriptions[0]!.trigger).toEqual(trigger)
  fake.fire({ trigger: { platform: 'state', entity_id: 'input_boolean.guest_mode' } })
  const result = await listening
  expect(JSON.parse(textOf(result))).toMatchObject({
    fired: true,
    variables: { trigger: { entity_id: 'input_boolean.guest_mode' } },
  })
  await vi.waitFor(() => expect(fake.subscriptions).toHaveLength(0))
})

test('ha_listen times out without an error', async () => {
  const result = await mcp.call('ha_listen', { trigger: { trigger: 'event', event_type: 'x' }, timeout_seconds: 1 })
  expect(result.isError).toBeFalsy()
  expect(textOf(result)).toBe('The trigger did not fire within 1 seconds.')
  expect(fake.subscriptions).toHaveLength(0)
})

test('ha_listen reports a trigger HA refuses', async () => {
  const result = await mcp.call('ha_listen', { trigger: { trigger: 'bogus' } })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain("Invalid trigger 'bogus'")
})

test('tools report when Home Assistant is not configured', async () => {
  const unconfigured = createHomeAssistant({ connection: () => undefined, logger: silent })
  unconfigured.start()
  const other = await startTestMcp({ homeAssistant: unconfigured })
  try {
    for (const [name, args] of [
      ['ha_list_devices', {}],
      ['ha_get_state', { entity_id: 'light.kitchen' }],
      ['ha_listen', { trigger: { trigger: 'event', event_type: 'x' } }],
    ] as const) {
      const result = await other.call(name, args)
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('Home Assistant is not connected to this Hobwork host')
    }
  } finally {
    await other.close()
  }
})
