// Runs against the dev instance from dev/homeassistant (see its README):
// HOBWORK_HA_TESTS=1 pnpm --filter @hobwork/server test src/homeassistant
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { HomeAssistantConnection } from '../config.ts'
import { startTestMcp, textOf } from '../mcp/test-mcp.ts'
import { createHomeAssistant, type HomeAssistant, type TriggerVariables } from './client.ts'
import { createTriggerRegistry } from './triggers.ts'

function connection(): HomeAssistantConnection {
  const envFile = resolve(import.meta.dirname, '../../../dev/homeassistant/.env.local')
  const vars: Record<string, string | undefined> = { ...process.env }
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) vars[line.slice(0, i)] ??= line.slice(i + 1)
    }
  }
  const { HOBWORK_HA_URL: url, HOBWORK_HA_TOKEN: token } = vars
  if (!url || !token) throw new Error('Set HOBWORK_HA_URL and HOBWORK_HA_TOKEN or run node dev/homeassistant/setup.ts')
  return { url, token }
}

const SWITCH = 'input_boolean.test_switch'
const silent = { info() {}, warn() {}, error() {} }

describe.runIf(process.env.HOBWORK_HA_TESTS === '1')('Home Assistant dev instance', () => {
  let ha: HomeAssistant

  beforeAll(async () => {
    const conn = connection()
    ha = createHomeAssistant({ connection: () => conn, logger: silent })
    ha.start()
    await ha.waitUntilConnected()
  })

  afterAll(() => ha?.stop())

  async function toggle(): Promise<string> {
    const before = (await ha.getState(SWITCH))?.state
    const next = before === 'on' ? 'off' : 'on'
    await ha.callService('input_boolean', next === 'on' ? 'turn_on' : 'turn_off', undefined, { entity_id: SWITCH })
    return next
  }

  test('call_service changes state', async () => {
    const next = await toggle()
    await vi.waitFor(async () => expect((await ha.getState(SWITCH))?.state).toBe(next))
  })

  test.each([
    ['trigger', { trigger: 'state', entity_id: SWITCH }],
    ['platform', { platform: 'state', entity_id: SWITCH }],
  ])('subscribe_trigger fires with the "%s" key', async (_, trigger) => {
    const fired: TriggerVariables[] = []
    const unsubscribe = await ha.subscribeTrigger(trigger, (variables) => void fired.push(variables))
    try {
      const next = await toggle()
      await vi.waitFor(() => expect(fired).toHaveLength(1), { timeout: 5000 })
      expect(fired[0]!.trigger).toMatchObject({ entity_id: SWITCH, to_state: { state: next } })
    } finally {
      await unsubscribe()
    }
  })

  test('lists devices, entities, services and device triggers', async () => {
    const [devices, entities, services, states] = await Promise.all([
      ha.listDevices(),
      ha.listEntities(),
      ha.listServices(),
      ha.getStates(),
    ])
    expect(devices.length).toBeGreaterThan(10)
    expect(entities.length).toBeGreaterThan(10)
    expect(services.input_boolean?.toggle).toBeDefined()
    expect(states.some((s) => s.entity_id === SWITCH)).toBe(true)

    let triggers: Record<string, unknown>[] = []
    for (const device of devices) {
      triggers = await ha.listDeviceTriggers(device.id)
      if (triggers.length) break
    }
    expect(triggers[0]).toMatchObject({ platform: 'device', device_id: expect.any(String) })
  })

  test('reads automation configs and what uses an entity', async () => {
    const automation = 'automation.test_button_emits_event'
    expect(await ha.getConfig(automation)).toMatchObject({
      triggers: [{ trigger: 'state', entity_id: 'input_button.test_button' }],
    })
    expect(await ha.searchRelated('entity', 'input_button.test_button')).toMatchObject({ automation: [automation] })
    await expect(ha.getConfig('automation.nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  test('reads traces, history, logbook, system log and statistics', async () => {
    await ha.callService('input_button', 'press', undefined, { entity_id: 'input_button.test_button' })
    const since = new Date(Date.now() - 3_600_000).toISOString()
    await vi.waitFor(async () => {
      expect((await ha.listTraces('automation', 'hobwork_test_button_event')).length).toBeGreaterThan(0)
    })
    const [latest] = (await ha.listTraces('automation', 'hobwork_test_button_event')).sort((a, b) =>
      b.timestamp.start.localeCompare(a.timestamp.start),
    )
    expect(latest).toMatchObject({ run_id: expect.any(String), trigger: 'state of input_button.test_button' })
    expect(await ha.getTrace('automation', 'hobwork_test_button_event', latest!.run_id)).toHaveProperty('trace')

    const next = await toggle()
    await vi.waitFor(async () => {
      const history = await ha.history({ start_time: since, entity_ids: [SWITCH], no_attributes: true })
      expect(history[SWITCH]?.at(-1)).toMatchObject({ s: next, lu: expect.any(Number) })
    })
    await vi.waitFor(async () => {
      const logbook = await ha.logbook({ start_time: since, entity_ids: ['automation.test_button_emits_event'] })
      expect(logbook.at(-1)).toMatchObject({ when: expect.any(Number), message: expect.stringContaining('triggered by') })
    })
    expect(Array.isArray(await ha.systemLog())).toBe(true)

    const ids = await ha.listStatisticIds()
    const outdoor = ids.find((s) => s.statistic_id === 'kitchen_sink:temperature_outdoor')
    expect(outdoor).toMatchObject({ has_mean: true })
    const statistics = await ha.statistics({
      start_time: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(),
      statistic_ids: [outdoor!.statistic_id],
      period: 'hour',
      types: ['mean'],
    })
    expect(statistics[outdoor!.statistic_id]?.[0]).toMatchObject({ start: expect.any(Number), mean: expect.any(Number) })
  })

  test('the trigger registry invokes the handler for a bus event trigger', async () => {
    const invocations: { project: string; name: string; variables: TriggerVariables }[] = []
    const registry = createTriggerRegistry({
      ha,
      invoke: (project, name, variables) => void invocations.push({ project, name, variables }),
      logger: silent,
    })
    const results = await registry.syncProjectTriggers('test-project', {
      'test-event': { homeassistant: { trigger: 'event', event_type: 'hobwork_test_event' }, handler: 'src/a.ts' },
    })
    expect(results).toEqual([{ name: 'test-event', status: 'subscribed' }])
    try {
      await ha.callService('input_button', 'press', undefined, { entity_id: 'input_button.test_button' })
      await vi.waitFor(() => expect(invocations).toHaveLength(1), { timeout: 5000 })
      expect(invocations[0]).toMatchObject({
        project: 'test-project',
        name: 'test-event',
        variables: { trigger: { event: { event_type: 'hobwork_test_event', data: { source: 'test_button' } } } },
      })
    } finally {
      await registry.removeProject('test-project')
    }
  })

  test('ha_listen over MCP returns the fired trigger', async () => {
    const mcp = await startTestMcp({ homeAssistant: ha })
    try {
      const { tools } = await mcp.client.listTools()
      expect(tools.map((t) => t.name)).toContain('ha_listen')

      const listening = mcp.call('ha_listen', { trigger: { trigger: 'state', entity_id: SWITCH }, timeout_seconds: 10 })
      // Give the subscription time to reach HA before causing the change.
      await new Promise((r) => setTimeout(r, 500))
      const next = await toggle()
      const result = await listening
      expect(result.isError, textOf(result)).toBeFalsy()
      expect(JSON.parse(textOf(result))).toMatchObject({
        fired: true,
        variables: { trigger: { entity_id: SWITCH, to_state: { state: next } } },
      })

      const automation = 'automation.test_button_emits_event'
      const [run] = JSON.parse(textOf(await mcp.call('ha_list_traces', { entity_id: automation })))
      expect(run).toMatchObject({ execution: 'finished', trigger: 'state of input_button.test_button' })
      const trace = JSON.parse(textOf(await mcp.call('ha_get_trace', { entity_id: automation, run_id: run.run_id })))
      expect(trace.trace['trigger/0'][0].changed_variables).not.toHaveProperty('this')
      // The recorder writes changes to its DB about a second later.
      await vi.waitFor(async () => {
        const history = JSON.parse(textOf(await mcp.call('ha_history', { entity_ids: [SWITCH], limit: 1 })))
        expect(history[SWITCH].changes).toEqual([{ state: next, last_changed: expect.any(String) }])
      })

      const devices = JSON.parse(textOf(await mcp.call('ha_list_devices', { limit: 5 })))
      expect(devices.items).toHaveLength(5)
      expect(devices.total).toBeGreaterThan(5)
    } finally {
      await mcp.close()
    }
  })
})
