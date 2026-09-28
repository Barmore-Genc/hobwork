import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createHomeAssistant, HomeAssistantError, webSocketUrl, type HomeAssistant, type Logger } from './client.ts'
import { startFakeHomeAssistant, type FakeHomeAssistant } from './fake-ha.ts'

let fake: FakeHomeAssistant
let ha: HomeAssistant
let logs: string[]

function testLogger(): Logger {
  const push = (level: string) => (...args: unknown[]) => logs.push(`${level}: ${args.map(String).join(' ')}`)
  return { info: push('info'), warn: push('warn'), error: push('error') }
}

function client(overrides: Partial<Parameters<typeof createHomeAssistant>[0]> = {}): HomeAssistant {
  ha = createHomeAssistant({
    connection: () => ({ url: fake.url, token: fake.token }),
    logger: testLogger(),
    requestTimeoutMs: 1000,
    reconnectDelayMs: { initial: 20, max: 100 },
    ...overrides,
  })
  ha.start()
  return ha
}

async function connectedClient(overrides: Partial<Parameters<typeof createHomeAssistant>[0]> = {}): Promise<HomeAssistant> {
  client(overrides)
  await ha.waitUntilConnected()
  return ha
}

beforeEach(async () => {
  logs = []
  fake = await startFakeHomeAssistant()
})

afterEach(async () => {
  ha?.stop()
  await fake.close()
})

test('builds the WebSocket URL from the HA base URL', () => {
  expect(webSocketUrl('http://ha.local:8123')).toBe('ws://ha.local:8123/api/websocket')
  expect(webSocketUrl('https://ha.example.com/')).toBe('wss://ha.example.com/api/websocket')
})

test('authenticates and correlates responses by id', async () => {
  fake.responses.set('get_states', () => [{ entity_id: 'light.a', state: 'on', attributes: {} }])
  fake.responses.set('config/device_registry/list', () => [{ id: 'dev1' }])
  client()
  const [states, devices, state] = await Promise.all([ha.getStates(), ha.listDevices(), ha.getState('light.a')])
  expect(states).toHaveLength(1)
  expect(devices).toEqual([{ id: 'dev1' }])
  expect(state?.state).toBe('on')
  expect(ha.status).toBe('connected')
  const ids = fake.received.map((m) => m.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test('sends call_service with data and target', async () => {
  fake.responses.set('call_service', () => ({ context: { id: 'c1', parent_id: null, user_id: null } }))
  client()
  const result = await ha.callService('light', 'turn_on', { brightness: 100 }, { entity_id: 'light.a' })
  expect(result.context.id).toBe('c1')
  expect(fake.received.at(-1)).toMatchObject({
    type: 'call_service',
    domain: 'light',
    service: 'turn_on',
    service_data: { brightness: 100 },
    target: { entity_id: 'light.a' },
  })
})

test('rejects with the HA error code', async () => {
  client()
  const err = await ha.request({ type: 'nonsense' }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(HomeAssistantError)
  expect(err).toMatchObject({ code: 'unknown_command' })
})

test('times out requests that get no answer', async () => {
  fake.silent.add('get_services')
  client()
  await expect(ha.request({ type: 'get_services' }, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' })
  // The connection is still usable afterwards.
  await expect(ha.request({ type: 'ping' })).resolves.toBeUndefined()
})

test('reports a missing configuration', async () => {
  client({ connection: () => undefined })
  expect(ha.status).toBe('unconfigured')
  await expect(ha.getStates()).rejects.toMatchObject({ code: 'not_configured' })
  await expect(ha.subscribeTrigger({ trigger: 'state' }, () => {})).rejects.toMatchObject({ code: 'not_configured' })
})

test('keeps retrying when the token is rejected', async () => {
  client({ connection: () => ({ url: fake.url, token: 'wrong' }) })
  await vi.waitFor(() => expect(logs.some((l) => l.includes('rejected the access token'))).toBe(true))
  await expect(ha.getStates()).rejects.toMatchObject({ code: 'not_connected' })
  fake.token = 'wrong'
  await vi.waitFor(() => expect(ha.status).toBe('connected'))
})

test('delivers trigger events to the subscriber and unsubscribes', async () => {
  await connectedClient()
  const fired: unknown[] = []
  const unsubscribe = await ha.subscribeTrigger({ trigger: 'state', entity_id: 'light.a' }, (variables, context) => {
    fired.push({ variables, context })
  })
  expect(fake.subscriptions).toHaveLength(1)
  expect(fake.subscriptions[0]!.trigger).toEqual({ trigger: 'state', entity_id: 'light.a' })
  fake.fire({ trigger: { platform: 'state', entity_id: 'light.a' } })
  await vi.waitFor(() => expect(fired).toHaveLength(1))
  expect(fired[0]).toMatchObject({ variables: { trigger: { entity_id: 'light.a' } }, context: { id: 'ctx' } })

  await unsubscribe()
  expect(fake.subscriptions).toHaveLength(0)
  await unsubscribe()
})

test('rejects a trigger HA refuses', async () => {
  await connectedClient()
  await expect(ha.subscribeTrigger({ trigger: 'bogus' }, () => {})).rejects.toMatchObject({ code: 'invalid_format' })
  expect(fake.subscriptions).toHaveLength(0)
})

test('a failing trigger callback does not break the connection', async () => {
  await connectedClient()
  await ha.subscribeTrigger({ trigger: 'event' }, () => {
    throw new Error('boom')
  })
  fake.fire({})
  await vi.waitFor(() => expect(logs.some((l) => l.includes('trigger callback failed'))).toBe(true))
  await expect(ha.request({ type: 'ping' })).resolves.toBeUndefined()
})

test('reconnects, resubscribes and logs missed triggers', async () => {
  await connectedClient()
  const fired: unknown[] = []
  await ha.subscribeTrigger({ trigger: 'state', entity_id: 'light.a' }, (v) => void fired.push(v))
  await ha.subscribeTrigger({ trigger: 'state', entity_id: 'light.b' }, (v) => void fired.push(v))
  fake.silent.add('get_states')
  const pendingRequest = ha.getStates()

  fake.dropConnections()
  await expect(pendingRequest).rejects.toMatchObject({ code: 'connection_lost' })
  fake.silent.clear()
  await vi.waitFor(() => expect(fake.subscriptions).toHaveLength(2))
  expect(fake.authenticated).toBe(2)
  expect(logs.some((l) => l.startsWith('warn: Lost the Home Assistant connection'))).toBe(true)
  expect(logs.some((l) => l.includes('were missed (2 trigger subscriptions affected)'))).toBe(true)

  fake.fire({ trigger: { n: 1 } })
  await vi.waitFor(() => expect(fired).toHaveLength(2))
})

test('subscriptions made while disconnected are set up on connect', async () => {
  fake.dropConnections()
  const port = new URL(fake.url).port
  await fake.close()
  client()
  await vi.waitFor(() => expect(ha.status).toBe('disconnected'))
  const fired: unknown[] = []
  await ha.subscribeTrigger({ trigger: 'event' }, (v) => void fired.push(v))

  fake = await startFakeHomeAssistant({ port: Number(port) })
  await vi.waitFor(() => expect(fake.subscriptions).toHaveLength(1))
  fake.fire({ trigger: {} })
  await vi.waitFor(() => expect(fired).toHaveLength(1))
})

test('a refused resubscription goes to onError and is retried on the next reconnect', async () => {
  await connectedClient()
  const errors: Error[] = []
  await ha.subscribeTrigger({ trigger: 'device', device_id: 'gone' }, () => {}, {
    onError: (err) => void errors.push(err),
  })
  fake.failures.set('subscribe_trigger', { code: 'invalid_format', message: 'Unknown device' })
  fake.dropConnections()
  await vi.waitFor(() => expect(errors).toHaveLength(1))
  expect(errors[0]!.message).toBe('Unknown device')

  fake.failures.clear()
  fake.dropConnections()
  await vi.waitFor(() => expect(fake.subscriptions).toHaveLength(1))
})

test('reconnects when pings go unanswered', async () => {
  await connectedClient({ pingIntervalMs: 50, requestTimeoutMs: 100 })
  fake.silent.add('ping')
  await vi.waitFor(() => expect(logs.some((l) => l.includes('did not answer a ping'))).toBe(true))
  fake.silent.clear()
  await vi.waitFor(() => expect(fake.authenticated).toBeGreaterThanOrEqual(2))
})

test('stop rejects pending requests and ends the connection', async () => {
  fake.silent.add('get_states')
  await connectedClient()
  const pendingRequest = ha.getStates()
  ha.stop()
  await expect(pendingRequest).rejects.toMatchObject({ code: 'stopped' })
  await expect(ha.getStates()).rejects.toMatchObject({ code: 'stopped' })
  expect(ha.status).toBe('stopped')
})
