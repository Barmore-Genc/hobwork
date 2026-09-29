import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createHomeAssistant, type HomeAssistant } from '../homeassistant/client.ts'
import { startFakeHomeAssistant, type FakeHomeAssistant } from '../homeassistant/fake-ha.ts'
import { getBranchHaApproval } from '../homeassistant/approvals.ts'
import { createProject } from '../projects.ts'
import { createBranch } from '../repo.ts'
import { seedMain } from '../test-project.ts'
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

test('shows an automation with its config and state', async () => {
  fake.responses.set('get_states', () => [
    {
      entity_id: 'automation.coffee_back',
      state: 'on',
      attributes: { friendly_name: 'Coffee came back', last_triggered: '2026-09-28T08:00:00+00:00' },
      last_changed: '',
      last_updated: '',
    },
  ])
  const config = { alias: 'Coffee came back', triggers: [{ trigger: 'device', device_id: 'd1' }], actions: [] }
  fake.responses.set('automation/config', (m) => {
    expect(m.entity_id).toBe('automation.coffee_back')
    return { config }
  })
  expect(await ok('ha_get_automation', { entity_id: 'automation.coffee_back' })).toEqual({
    entity_id: 'automation.coffee_back',
    name: 'Coffee came back',
    state: 'on',
    last_triggered: '2026-09-28T08:00:00+00:00',
    config,
  })

  expect(textOf(await mcp.call('ha_get_automation', { entity_id: 'light.kitchen' }))).toContain('automation.* or script.*')
  fake.responses.delete('automation/config')
  fake.failures.set('automation/config', { code: 'not_found', message: 'Entity not found' })
  const missing = await mcp.call('ha_get_automation', { entity_id: 'automation.nope' })
  expect(missing.isError).toBe(true)
  expect(textOf(missing)).toContain('ha_list_entities')
})

test('finds related items', async () => {
  fake.responses.set('search/related', (m) => {
    expect(m).toMatchObject({ item_type: 'device', item_id: 'd1' })
    return { automation: ['automation.coffee_back'], entity: ['sensor.desk_battery'] }
  })
  expect(await ok('ha_find_related', { item_type: 'device', item_id: 'd1' })).toEqual({
    automation: ['automation.coffee_back'],
    entity: ['sensor.desk_battery'],
  })
})

test('lists and shows automation traces by the automation id', async () => {
  fake.responses.set('get_states', () => [
    { entity_id: 'automation.coffee_back', state: 'on', attributes: { id: 'coffee1' }, last_changed: '', last_updated: '' },
    { entity_id: 'automation.no_id', state: 'on', attributes: {}, last_changed: '', last_updated: '' },
  ])
  const summary = (run_id: string, startedAt: string) => ({
    run_id,
    state: 'stopped',
    script_execution: 'error',
    timestamp: { start: startedAt, finish: startedAt },
    trigger: 'event of zha_event',
    last_step: 'action/1',
    error: 'Service tts.speak not found',
    domain: 'automation',
    item_id: 'coffee1',
  })
  fake.responses.set('trace/list', (m) => {
    expect(m).toMatchObject({ domain: 'automation', item_id: 'coffee1' })
    return [summary('old', '2026-09-28T08:00:00+00:00'), summary('new', '2026-09-29T08:00:00+00:00')]
  })
  const traces = await ok('ha_list_traces', { entity_id: 'automation.coffee_back' })
  expect(traces.map((t: any) => t.run_id)).toEqual(['new', 'old'])
  expect(traces[0]).toMatchObject({ execution: 'error', last_step: 'action/1', error: 'Service tts.speak not found' })

  fake.responses.set('trace/get', (m) => {
    expect(m).toMatchObject({ domain: 'automation', item_id: 'coffee1', run_id: 'new' })
    return {
      ...summary('new', '2026-09-29T08:00:00+00:00'),
      config: { alias: 'Coffee came back' },
      blueprint_inputs: null,
      trace: {
        'trigger/0': [{ path: 'trigger/0', changed_variables: { this: { state: 'on' }, trigger: { platform: 'event' } } }],
        'action/1': [{ path: 'action/1', error: 'Service tts.speak not found' }],
      },
    }
  })
  const trace = await ok('ha_get_trace', { entity_id: 'automation.coffee_back', run_id: 'new' })
  expect(trace).not.toHaveProperty('config')
  expect(trace.trace['trigger/0'][0].changed_variables).toEqual({ trigger: { platform: 'event' } })
  expect(trace.trace['action/1'][0].error).toBe('Service tts.speak not found')

  expect(textOf(await mcp.call('ha_list_traces', { entity_id: 'automation.no_id' }))).toContain('no id in its config')
  fake.responses.set('trace/list', (m) => {
    expect(m).toMatchObject({ domain: 'script', item_id: 'announce' })
    return []
  })
  expect(await ok('ha_list_traces', { entity_id: 'script.announce' })).toEqual([])
})

test('shows history with times and the latest changes per entity', async () => {
  fake.responses.set('history/history_during_period', (m) => {
    expect(m).toMatchObject({ entity_ids: ['binary_sensor.door', 'sensor.nope'], no_attributes: true, minimal_response: true })
    expect(Date.now() - Date.parse(m.start_time as string)).toBeGreaterThan(23 * 3_600_000)
    return {
      'binary_sensor.door': [
        { s: 'off', lu: 1790640000 },
        { s: 'on', lu: 1790640060 },
        { s: 'off', lu: 1790640120 },
      ],
    }
  })
  expect(await ok('ha_history', { entity_ids: ['binary_sensor.door', 'sensor.nope'], limit: 2 })).toEqual({
    'binary_sensor.door': {
      total: 3,
      changes: [
        { state: 'on', last_changed: new Date(1790640060_000).toISOString() },
        { state: 'off', last_changed: new Date(1790640120_000).toISOString() },
      ],
    },
    'sensor.nope': { total: 0, changes: [] },
  })

  fake.responses.set('history/history_during_period', (m) => {
    expect(m).toMatchObject({ start_time: '2026-09-28T06:00:00+02:00', no_attributes: false, minimal_response: false })
    return { 'light.kitchen': [{ s: 'on', a: { brightness: 10 }, lu: 1790640060, lc: 1790640000 }] }
  })
  expect(
    await ok('ha_history', { entity_ids: ['light.kitchen'], start: '2026-09-28T06:00:00+02:00', attributes: true }),
  ).toMatchObject({
    'light.kitchen': {
      changes: [
        {
          state: 'on',
          last_changed: new Date(1790640000_000).toISOString(),
          last_updated: new Date(1790640060_000).toISOString(),
          attributes: { brightness: 10 },
        },
      ],
    },
  })
  expect((await mcp.call('ha_history', { entity_ids: ['light.kitchen'], start: 'yesterday' })).isError).toBe(true)
})

test('shows the logbook newest first', async () => {
  fake.responses.set('logbook/get_events', (m) => {
    expect(m).toMatchObject({ device_ids: ['d1'] })
    expect(m).not.toHaveProperty('entity_ids')
    return [
      { when: 1790640000, name: 'Coffee came back', message: 'triggered by event zha_event' },
      { when: 1790640060, entity_id: 'light.kitchen', state: 'on' },
    ]
  })
  const logbook = await ok('ha_logbook', { device_ids: ['d1'] })
  expect(logbook.total).toBe(2)
  expect(logbook.items[0]).toEqual({ when: new Date(1790640060_000).toISOString(), entity_id: 'light.kitchen', state: 'on' })
})

test('shows the system log with filters', async () => {
  const entry = (name: string, level: string, message: string, timestamp: number) => ({
    name,
    message: [message],
    level,
    source: ['components/zha/core.py', 12],
    timestamp,
    exception: '',
    count: 1,
    first_occurred: timestamp,
  })
  fake.responses.set('system_log/list', () => [
    entry('homeassistant.components.zha', 'WARNING', 'Device offline', 1790640000),
    entry('homeassistant.components.tts', 'ERROR', 'Speaker unavailable', 1790640060),
  ])
  const all = await ok('ha_system_log')
  expect(all.items.map((e: any) => e.logger)).toEqual(['homeassistant.components.tts', 'homeassistant.components.zha'])
  expect(all.items[0]).toMatchObject({ level: 'ERROR', source: 'components/zha/core.py:12', message: 'Speaker unavailable' })
  expect((await ok('ha_system_log', { level: 'warning' })).items.map((e: any) => e.message)).toEqual(['Device offline'])
  expect((await ok('ha_system_log', { search: 'speaker' })).total).toBe(1)
})

test('lists and reads long-term statistics', async () => {
  fake.responses.set('recorder/list_statistic_ids', () => [
    {
      statistic_id: 'sensor.outdoor',
      name: 'Outdoor',
      source: 'recorder',
      statistics_unit_of_measurement: '°C',
      has_mean: true,
      has_sum: false,
    },
    { statistic_id: 'sensor.energy', name: null, source: 'recorder', statistics_unit_of_measurement: 'kWh', has_mean: false, has_sum: true },
  ])
  expect((await ok('ha_list_statistics', { search: 'outdoor' })).items).toEqual([
    { statistic_id: 'sensor.outdoor', name: 'Outdoor', unit: '°C', source: 'recorder', has_mean: true, has_sum: false },
  ])

  fake.responses.set('recorder/statistics_during_period', (m) => {
    expect(m).toMatchObject({ statistic_ids: ['sensor.outdoor'], period: 'day', types: ['mean'] })
    expect(Date.now() - Date.parse(m.start_time as string)).toBeGreaterThan(6 * 24 * 3_600_000)
    return { 'sensor.outdoor': [{ start: 1790640000_000, end: 1790726400_000, mean: 12.5 }] }
  })
  expect(await ok('ha_statistics', { statistic_ids: ['sensor.outdoor'], period: 'day', types: ['mean'] })).toEqual({
    'sensor.outdoor': [
      { start: new Date(1790640000_000).toISOString(), end: new Date(1790726400_000).toISOString(), mean: 12.5 },
    ],
  })
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

test('agents let a branch control Home Assistant and take it back', async () => {
  await createProject(mcp.host, 'lights')
  await seedMain(mcp.host, 'lights')
  await createBranch(mcp.host, 'lights', 'dim')
  const set = (branch: string, allowed: boolean) => mcp.call('set_branch_home_assistant', { project: 'lights', branch, allowed })

  expect(textOf(await set('dim', true))).toBe('Branch "dim" of lights can now control Home Assistant.')
  expect(getBranchHaApproval(mcp.host, 'lights', 'dim')).toMatchObject({ by: 'claude', byAgent: true })
  expect(textOf(await set('dim', false))).toBe('Branch "dim" of lights can no longer control Home Assistant.')
  expect(getBranchHaApproval(mcp.host, 'lights', 'dim')).toBeUndefined()
  expect((await set('main', true)).isError).toBe(true)
  expect((await set('nope', true)).isError).toBe(true)
})
