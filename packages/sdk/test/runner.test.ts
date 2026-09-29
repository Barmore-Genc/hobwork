import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { InvocationKind } from '../src/index.ts'
import type { InvokeRequest, InvokeResult, LogLine } from '../src/runner/protocol.ts'
import { startRunner, type Runner } from '../src/runner/runner.ts'

let app: string
let internal: Server
let internalUrl: string
let received: LogLine[]
let runner: Runner | undefined
let url: string

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
}

function write(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(app, path)), { recursive: true })
    writeFileSync(join(app, path), content)
  }
}

async function start(handlers: string[] = []) {
  runner = await startRunner({ appDir: app, internalUrl, handlers }, 0)
  url = `http://127.0.0.1:${(runner.server.address() as AddressInfo).port}`
}

let nextId = 1
async function invoke(handler: string, extra: Partial<InvokeRequest> = {}, kind: InvocationKind = 'route'): Promise<InvokeResult & { id: number }> {
  const id = nextId++
  const message: InvokeRequest = { invocation: { id, kind, name: handler, manual: false }, handler, ...extra }
  const res = await fetch(`${url}/invoke`, { method: 'POST', body: JSON.stringify(message) })
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
  internal = createServer((req, res) => {
    let data = ''
    req.on('data', (chunk: Buffer) => (data += chunk))
    req.on('end', () => {
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
  expect((await fetch(`${url}/ready`)).status).toBe(200)
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
