import { afterEach, beforeEach, expect, test } from 'vitest'
import { createHomeAssistant, type HomeAssistant } from './client.ts'
import { startFakeHomeAssistant, type FakeHomeAssistant } from './fake-ha.ts'
import { haResponse, type HaAccess, type HaCallLog } from './internal.ts'

let fake: FakeHomeAssistant
let ha: HomeAssistant
let logged: HaCallLog[]

const STATES = [
  { entity_id: 'light.kitchen', state: 'on', attributes: { brightness: 200 }, last_changed: '', last_updated: '' },
  { entity_id: 'light.hall', state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  { entity_id: 'sensor.temperature', state: '21.5', attributes: {}, last_changed: '', last_updated: '' },
]

async function call(request: object, access: HaAccess = 'full', client: HomeAssistant | undefined = ha) {
  const res = await haResponse(JSON.stringify(request), { ha: client, access, log: (entry) => logged.push(entry) })
  return { status: res.status, body: (await res.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } } }
}

beforeEach(async () => {
  logged = []
  fake = await startFakeHomeAssistant()
  fake.responses.set('get_states', () => STATES)
  fake.responses.set('call_service', () => ({ context: { id: 'c1', parent_id: null, user_id: null } }))
  fake.responses.set('fire_event', () => ({ context: { id: 'c2', parent_id: null, user_id: null } }))
  ha = createHomeAssistant({
    connection: () => ({ url: fake.url, token: fake.token }),
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 500,
  })
  ha.start()
  await ha.waitUntilConnected()
})

afterEach(async () => {
  ha.stop()
  await fake.close()
})

test('calls a service with data and target and logs it with the invocation', async () => {
  const { status, body } = await call({
    action: 'callService',
    domain: 'light',
    service: 'turn_on',
    data: { brightness: 100 },
    target: { entity_id: 'light.kitchen' },
    invocation: 7,
  })
  expect(status).toBe(200)
  expect(body).toEqual({ ok: true, result: { context: { id: 'c1', parent_id: null, user_id: null } } })
  expect(fake.received.find((m) => m.type === 'call_service')).toMatchObject({
    domain: 'light',
    service: 'turn_on',
    service_data: { brightness: 100 },
    target: { entity_id: 'light.kitchen' },
  })
  expect(logged).toEqual([
    { invocation: 7, level: 'info', message: 'Home Assistant: light.turn_on {"brightness":100} target {"entity_id":"light.kitchen"}' },
  ])
})

test('reads one state, filtered states and a missing entity', async () => {
  expect((await call({ action: 'getState', entityId: 'light.hall' })).body.result).toMatchObject({ state: 'off' })
  expect((await call({ action: 'getState', entityId: 'light.nope' })).body).toEqual({ ok: true, result: null })
  const lights = (await call({ action: 'getStates', filter: { domain: 'light' } })).body.result as { entity_id: string }[]
  expect(lights.map((s) => s.entity_id)).toEqual(['light.kitchen', 'light.hall'])
  const some = (await call({ action: 'getStates', filter: { entityIds: ['sensor.temperature'] } })).body.result as unknown[]
  expect(some).toHaveLength(1)
  expect(((await call({ action: 'getStates' })).body.result as unknown[]).length).toBe(3)
  expect(logged.every((entry) => entry.level === 'debug')).toBe(true)
})

test('fires events', async () => {
  const { body } = await call({ action: 'fireEvent', eventType: 'spool_empty', data: { spool: 7 } })
  expect(body.ok).toBe(true)
  expect(fake.received.find((m) => m.type === 'fire_event')).toMatchObject({ event_type: 'spool_empty', event_data: { spool: 7 } })
})

test('workspaces only read states', async () => {
  const service = await call({ action: 'callService', domain: 'light', service: 'turn_on' }, 'read')
  expect(service.status).toBe(403)
  expect(service.body.error?.code).toBe('read_only')
  const event = await call({ action: 'fireEvent', eventType: 'x' }, 'read')
  expect(event.body.error?.code).toBe('read_only')
  expect(fake.received.some((m) => m.type === 'call_service' || m.type === 'fire_event')).toBe(false)
  expect((await call({ action: 'getState', entityId: 'light.hall' }, 'read')).body.ok).toBe(true)
})

test("passes on Home Assistant's error code and message", async () => {
  fake.failures.set('call_service', { code: 'service_not_found', message: 'Action light.explode not found' })
  const { status, body } = await call({ action: 'callService', domain: 'light', service: 'explode', invocation: 3 })
  expect(status).toBe(502)
  expect(body).toEqual({ ok: false, error: { code: 'service_not_found', message: 'Action light.explode not found' } })
  expect(logged).toEqual([
    { invocation: 3, level: 'warn', message: 'Home Assistant: light.explode failed: Action light.explode not found' },
  ])
})

test('answers 503 when Home Assistant is not configured or not connected', async () => {
  const unconfigured = createHomeAssistant({ connection: () => undefined })
  const res = await call({ action: 'getStates' }, 'full', unconfigured)
  expect(res.status).toBe(503)
  expect(res.body.error?.code).toBe('not_configured')
  expect((await haResponse('{"action":"getStates"}', { access: 'full' })).status).toBe(503)

  fake.dropConnections()
  await fake.close()
  const down = await call({ action: 'getStates' })
  expect(down.status).toBe(503)
  expect(down.body.error?.code).toMatch(/not_connected|connection_lost/)
})

test('times out as 504', async () => {
  fake.silent.add('get_states')
  const res = await call({ action: 'getStates' })
  expect(res.status).toBe(504)
  expect(res.body.error?.code).toBe('timeout')
})

test('refuses malformed requests', async () => {
  for (const request of [
    { action: 'callService', domain: 'light', service: 'turn on' },
    { action: 'callService', domain: 'light', service: 'turn_on', data: [1] },
    { action: 'getState', entityId: 'kitchen' },
    { action: 'getStates', filter: { entityIds: 'light.hall' } },
    { action: 'fireEvent', eventType: '' },
    { action: 'restart' },
  ]) {
    const res = await call(request)
    expect(res.status, JSON.stringify(request)).toBe(400)
    expect(res.body.error?.code).toBe('bad_request')
  }
  expect((await haResponse('not json', { ha, access: 'full' })).status).toBe(400)
  expect(fake.received.some((m) => m.type === 'call_service')).toBe(false)
})
