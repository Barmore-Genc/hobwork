import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { InvocationKind } from '../src/index.ts'
import type { DbRequest, DeviceRequest, HaRequest, InvokeRequest, InvokeResult, LogLine } from '../src/runner/protocol.ts'
import { MAX_RESPONSE_BODY_BYTES } from '../src/runner/protocol.ts'
import { startRunner, type Runner } from '../src/runner/runner.ts'

let app: string
let internal: Server
let internalUrl: string
let received: LogLine[]
let dbRequests: DbRequest[]
let haRequests: HaRequest[]
let deviceRequests: DeviceRequest[]
let runner: Runner | undefined
let url: string

const TOKEN = 'test-token'

const HANDLERS: Record<string, string> = {
  'handlers/src/json.js': 'export default async (ctx) => ({ params: ctx.params, name: ctx.invocation.name })',
  'handlers/src/response.js': `export default async (ctx) => {
    const body = await ctx.request.text()
    return new Response('echo ' + body, { status: 201, headers: { 'x-test': 'yes', 'content-length': '999' } })
  }`,
  'handlers/src/empty.js': 'export default async () => undefined',
  'handlers/src/throws.js': `export default async () => {
    console.log('about to fail')
    throw new TypeError('spools is not iterable')
  }`,
  'handlers/src/logs.js': `export default async (ctx) => {
    console.log('start', ctx.payload.tag)
    await new Promise((r) => setTimeout(r, ctx.payload.delay))
    ctx.log.warn('end', ctx.payload.tag)
    return ctx.payload.tag
  }`,
  'handlers/src/broken.js': 'export const notDefault = 1',
  'handlers/src/db.js': `export default async (ctx) => {
    const rows = await ctx.db.query('SELECT ? AS blob', [new Uint8Array([7])])
    let error
    try { await ctx.db.run('BAD') } catch (err) { error = err.name + ': ' + err.message + ' @' + err.statement }
    return { blob: Array.from(rows[0].blob), error, secrets: ctx.secrets }
  }`,
  'handlers/src/ha.js': `export default async (ctx) => {
    const state = await ctx.ha.getState('light.kitchen')
    let error
    try { await ctx.ha.callService('light', 'explode') } catch (err) { error = [err.name, err.code, err.message] }
    return { state: state.state, error }
  }`,
  'handlers/src/device.js': `export default async (ctx) => {
    const sent = await ctx.device('kaan-iphone').notifications.send({ title: 'Print done' })
    let error
    try { await ctx.device('nope').notifications.send({ title: 'Hi' }) } catch (err) { error = [err.name, err.code, err.message] }
    return { sent, devices: await ctx.devices(), error }
  }`,
}

function write(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(app, path)), { recursive: true })
    writeFileSync(join(app, path), content)
  }
}

async function start(handlers: string[] = []) {
  runner = await startRunner({ appDir: app, internalUrl, token: TOKEN, handlers }, 0)
  url = `http://127.0.0.1:${(runner.server.address() as AddressInfo).port}`
}

let nextId = 1
async function invoke(handler: string, extra: Partial<InvokeRequest> = {}, kind: InvocationKind = 'route'): Promise<InvokeResult & { id: number }> {
  const id = nextId++
  const message: InvokeRequest = { invocation: { id, kind, name: handler, manual: false }, handler, ...extra }
  const res = await fetch(`${url}/invoke`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(message) })
  return { ...((await res.json()) as InvokeResult), id }
}

function body(result: InvokeResult): string {
  if (!result.ok) throw new Error(result.error.message)
  return Buffer.from(result.response.body, 'base64').toString()
}

beforeEach(async () => {
  app = mkdtempSync(join(tmpdir(), 'hobwork-runner-'))
  write(HANDLERS)
  received = []
  dbRequests = []
  haRequests = []
  deviceRequests = []
  internal = createServer((req, res) => {
    let data = ''
    req.on('data', (chunk: Buffer) => (data += chunk))
    req.on('end', () => {
      if (req.url === '/v1/db') {
        const request = JSON.parse(data) as DbRequest
        dbRequests.push(request)
        const response =
          request.statements[0]?.sql === 'BAD'
            ? { ok: false, error: { message: 'syntax error', statement: 0 } }
            : { ok: true, results: [{ rows: [{ blob: request.statements[0]?.params?.[0 as never] }], changes: 0, lastInsertRowid: 0 }] }
        res.writeHead(response.ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(response))
        return
      }
      if (req.url === '/v1/ha') {
        const request = JSON.parse(data) as HaRequest
        haRequests.push(request)
        const response =
          request.action === 'getState'
            ? { ok: true, result: { entity_id: request.entityId, state: 'on', attributes: {} } }
            : { ok: false, error: { code: 'service_not_found', message: 'Action light.explode not found' } }
        res.writeHead(response.ok ? 200 : 502, { 'content-type': 'application/json' }).end(JSON.stringify(response))
        return
      }
      if (req.url === '/v1/devices') {
        const request = JSON.parse(data) as DeviceRequest
        deviceRequests.push(request)
        const response =
          request.action === 'list'
            ? { ok: true, result: [{ name: 'kaan-iphone' }] }
            : request.device === 'kaan-iphone'
              ? { ok: true, result: { id: 'n1', delivery: 'app' } }
              : { ok: false, error: { code: 'unknown_device', message: 'No device called "nope"' } }
        res.writeHead(response.ok ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(response))
        return
      }
      if (req.url === '/v1/logs') received.push(...(JSON.parse(data) as { lines: LogLine[] }).lines)
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve))
  internalUrl = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`
})

afterEach(async () => {
  await runner?.close()
  runner = undefined
  await new Promise((resolve) => internal.close(resolve))
  rmSync(app, { recursive: true, force: true })
})

test('answers readiness checks', async () => {
  await start(['src/json.ts'])
  expect((await fetch(`${url}/ready`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
})

test('sends a returned value as JSON', async () => {
  await start()
  const result = await invoke('src/json.ts', { params: { id: '42' } })
  expect(result.ok && result.response.status).toBe(200)
  expect(result.ok && result.response.headers).toEqual([['content-type', 'application/json']])
  expect(JSON.parse(body(result))).toEqual({ params: { id: '42' }, name: 'src/json.ts' })
})

test('passes the request and sends a returned Response as is', async () => {
  await start()
  const request = { method: 'POST', url: 'http://localhost/p/x/api/echo', headers: [], body: Buffer.from('hi').toString('base64') }
  const result = await invoke('src/response.ts', { request })
  expect(result.ok && result.response.status).toBe(201)
  expect(result.ok && result.response.headers).toContainEqual(['x-test', 'yes'])
  expect(result.ok && result.response.headers.some(([name]) => name === 'content-length')).toBe(false)
  expect(body(result)).toBe('echo hi')
})

test('undefined answers 204', async () => {
  await start()
  const result = await invoke('src/empty.ts', {}, 'cron')
  expect(result.ok && result.response.status).toBe(204)
})

test('returns a thrown error with its stack and keeps the console output', async () => {
  await start()
  const result = await invoke('src/throws.ts')
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error).toMatchObject({ name: 'TypeError', message: 'spools is not iterable' })
  expect(result.error.stack).toContain('throws.js')
  expect(received).toEqual([expect.objectContaining({ invocation: result.id, level: 'info', message: 'about to fail' })])
})

test('attributes console output to concurrent invocations', async () => {
  await start()
  const [slow, fast] = await Promise.all([
    invoke('src/logs.ts', { payload: { tag: 'slow', delay: 50 } }, 'trigger'),
    invoke('src/logs.ts', { payload: { tag: 'fast', delay: 0 } }, 'trigger'),
  ])
  const linesOf = (id: number) => received.filter((l) => l.invocation === id).map((l) => `${l.level} ${l.message}`)
  expect(linesOf(slow.id)).toEqual(['info start slow', 'warn end slow'])
  expect(linesOf(fast.id)).toEqual(['info start fast', 'warn end fast'])
})

test('fails to start when a handler does not export a function', async () => {
  await expect(start(['src/broken.ts'])).rejects.toThrow('does not default-export a handler function')
})

test('reports a missing handler module as an invocation error', async () => {
  await start()
  const result = await invoke('src/missing.ts')
  expect(result.ok).toBe(false)
})

test('handlers reach the host DB with ctx.db and see secret placeholders in ctx.secrets', async () => {
  runner = await startRunner({ appDir: app, internalUrl, token: TOKEN, handlers: [], secrets: { API_KEY: 'GONDOLIN_SECRET_abc' } }, 0)
  url = `http://127.0.0.1:${(runner.server.address() as AddressInfo).port}`
  const result = await invoke('src/db.ts')
  expect(JSON.parse(body(result))).toEqual({
    blob: [7],
    error: 'DbError: syntax error @0',
    secrets: { API_KEY: 'GONDOLIN_SECRET_abc' },
  })
  expect(dbRequests[0]).toEqual({
    statements: [{ sql: 'SELECT ? AS blob', params: [{ $blob: 'Bw==' }] }],
    transaction: false,
    invocation: result.id,
  })
})

test('handlers call Home Assistant with ctx.ha, and its errors throw as HomeAssistantError', async () => {
  await start()
  const result = await invoke('src/ha.ts')
  expect(JSON.parse(body(result))).toEqual({
    state: 'on',
    error: ['HomeAssistantError', 'service_not_found', 'Action light.explode not found'],
  })
  expect(haRequests).toEqual([
    { action: 'getState', entityId: 'light.kitchen', invocation: result.id },
    { action: 'callService', domain: 'light', service: 'explode', invocation: result.id },
  ])
})

test('handlers reach devices with ctx.device and ctx.devices, and failures throw as DeviceError', async () => {
  await start()
  const result = await invoke('src/device.ts')
  expect(JSON.parse(body(result))).toEqual({
    sent: { id: 'n1', delivery: 'app' },
    devices: [{ name: 'kaan-iphone' }],
    error: ['DeviceError', 'unknown_device', 'No device called "nope"'],
  })
  expect(deviceRequests).toEqual([
    { action: 'call', device: 'kaan-iphone', capability: 'notifications', method: 'send', args: { title: 'Print done' }, invocation: result.id },
    { action: 'call', device: 'nope', capability: 'notifications', method: 'send', args: { title: 'Hi' }, invocation: result.id },
    { action: 'list', invocation: result.id },
  ])
})

test('rejects requests without the token, including /ready', async () => {
  await start()
  const message = { invocation: { id: 1, kind: 'route', name: 'x', manual: false }, handler: 'src/json.ts' }
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer test-toke' }, { authorization: TOKEN }]) {
    expect((await fetch(`${url}/invoke`, { method: 'POST', headers, body: JSON.stringify(message) })).status).toBe(401)
    expect((await fetch(`${url}/ready`, { headers })).status).toBe(401)
  }
  expect((await fetch(`${url}/ready`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
})

test('fails an invocation whose response body is too large', async () => {
  write({
    'handlers/src/big.js': `export default async () => new Response(new Uint8Array(${MAX_RESPONSE_BODY_BYTES + 1}))`,
    'handlers/src/limit.js': `export default async () => new Response(new Uint8Array(${MAX_RESPONSE_BODY_BYTES}))`,
  })
  await start()
  const big = await invoke('src/big.ts')
  expect(big.ok).toBe(false)
  if (!big.ok) expect(big.error.message).toBe('The response body is larger than 24MB')
  expect((await invoke('src/limit.ts')).ok).toBe(true)
})
