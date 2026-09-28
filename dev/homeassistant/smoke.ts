// Usage: node dev/homeassistant/smoke.ts
// Reads HOBWORK_HA_URL / HOBWORK_HA_TOKEN from the environment, falling back to .env.local.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const envFile = join(dirname(fileURLToPath(import.meta.url)), '.env.local')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) process.env[line.slice(0, i)] ??= line.slice(i + 1)
  }
}
const url = process.env.HOBWORK_HA_URL
const token = process.env.HOBWORK_HA_TOKEN
if (!url || !token) throw new Error('HOBWORK_HA_URL and HOBWORK_HA_TOKEN are required (run setup.ts)')

const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/websocket`)
let nextId = 1
const pending = new Map<number, (msg: any) => void>()
const subscribers = new Map<number, (msg: any) => void>()

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }))
  else if (msg.type === 'auth_ok') authed()
  else if (msg.type === 'auth_invalid') throw new Error('auth_invalid')
  else if (msg.type === 'result') pending.get(msg.id)?.(msg)
  else if (msg.type === 'event') subscribers.get(msg.id)?.(msg.event)
}

let authed: () => void
const ready = new Promise<void>((r) => (authed = r))

function send(payload: Record<string, unknown>): Promise<any> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.success ? resolve(msg.result) : reject(new Error(JSON.stringify(msg.error)))))
    ws.send(JSON.stringify({ id, ...payload }))
  })
}

function subscribeTrigger(trigger: Record<string, unknown>, onEvent: (e: any) => void) {
  const id = nextId
  subscribers.set(id, onEvent)
  return send({ type: 'subscribe_trigger', trigger })
}

function timeout<T>(p: Promise<T>, what: string, ms = 10000): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))])
}

await ready
const cfg = await send({ type: 'get_config' })
console.log(`HA ${cfg.version}, connected`)

const entity = 'input_boolean.test_switch'
const fired = new Promise<any>((resolve) => {
  subscribeTrigger({ platform: 'state', entity_id: entity }, resolve)
})
await new Promise((r) => setTimeout(r, 500))
const before = (await send({ type: 'get_states' })).find((s: any) => s.entity_id === entity)?.state
await send({
  type: 'call_service',
  domain: 'input_boolean',
  service: before === 'on' ? 'turn_off' : 'turn_on',
  target: { entity_id: entity },
})
const event = await timeout(fired, 'state trigger')
console.log('state trigger payload:', JSON.stringify(event.variables.trigger, null, 2).slice(0, 600))

const busFired = new Promise<any>((resolve) => {
  subscribeTrigger({ platform: 'event', event_type: 'hobwork_test_event' }, resolve)
})
await new Promise((r) => setTimeout(r, 500))
await send({ type: 'call_service', domain: 'input_button', service: 'press', target: { entity_id: 'input_button.test_button' } })
const busEvent = await timeout(busFired, 'event trigger')
console.log('event trigger payload:', JSON.stringify(busEvent.variables.trigger.event.data))

const devices: any[] = await send({ type: 'config/device_registry/list' })
const entities: any[] = await send({ type: 'config/entity_registry/list' })
console.log(`${devices.length} devices`)
let withTriggers = 0
let pressTrigger: any
for (const d of devices) {
  const triggers: any[] = await send({ type: 'device_automation/trigger/list', device_id: d.id })
  if (triggers.length === 0) continue
  withTriggers++
  pressTrigger ??= triggers.find((t) => t.domain === 'button' && t.type === 'pressed')
}
console.log(`${withTriggers} devices have device triggers`)

if (pressTrigger) {
  console.log('device trigger definition:', JSON.stringify(pressTrigger))
  const deviceFired = new Promise<any>((resolve) => subscribeTrigger(pressTrigger, resolve))
  await new Promise((r) => setTimeout(r, 500))
  const entityId = entities.find((e) => e.id === pressTrigger.entity_id).entity_id
  await send({ type: 'call_service', domain: 'button', service: 'press', target: { entity_id: entityId } })
  const dev = await timeout(deviceFired, 'device trigger')
  const { from_state, to_state, ...rest } = dev.variables.trigger
  console.log('device trigger payload:', JSON.stringify(rest))
} else {
  console.log('no button device trigger found, skipping device trigger check')
}
ws.close()
