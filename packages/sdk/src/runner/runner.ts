import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { format } from 'node:util'
import type { Context, Handler, Invocation, LogLevel, Logger } from '../index.ts'
import { createDbClient, httpDbSender } from './db-client.ts'
import { createDeviceClient, httpDeviceSender } from './device-client.ts'
import { createHaClient, httpHaSender } from './ha-client.ts'
import { createHostClient, type HostClient } from './host-client.ts'
import {
  handlerModulePath,
  type InvokeRequest,
  type InvokeResult,
  type SerializedError,
  type SerializedRequest,
  type SerializedResponse,
} from './protocol.ts'

export type RunnerOptions = {
  // The deployed build (the project's dist/), mounted read-only.
  appDir: string
  internalUrl: string
  // Loaded before the runner reports ready, so a handler that fails to import
  // fails the start instead of every invocation.
  handlers: string[]
  // Secret name -> placeholder, handed to handlers as ctx.secrets.
  secrets?: Record<string, string>
}

export type Runner = {
  server: Server
  close(): Promise<void>
}

const MAX_BODY_BYTES = 10 * 1024 * 1024

// Set by the proxy, so a body that fetch() already decoded would be decoded
// twice by the client.
const DROPPED_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection'])

const CONSOLE_LEVELS: Record<string, LogLevel> = {
  debug: 'debug',
  trace: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack }
  return { name: 'Error', message: `Non-error thrown: ${format(err)}` }
}

function toRequest(serialized: SerializedRequest): Request {
  const method = serialized.method.toUpperCase()
  const body = serialized.body && method !== 'GET' && method !== 'HEAD' ? Buffer.from(serialized.body, 'base64') : undefined
  return new Request(serialized.url, { method, headers: serialized.headers, body })
}

async function toSerializedResponse(value: unknown): Promise<SerializedResponse> {
  if (value instanceof Response) {
    const headers = [...value.headers].filter(([name]) => !DROPPED_RESPONSE_HEADERS.has(name))
    const body = Buffer.from(await value.arrayBuffer()).toString('base64')
    return { status: value.status, headers, body }
  }
  if (value === undefined) return { status: 204, headers: [], body: '' }
  return {
    status: 200,
    headers: [['content-type', 'application/json']],
    body: Buffer.from(JSON.stringify(value)).toString('base64'),
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startRunner(options: RunnerOptions, port: number): Promise<Runner> {
  const client: HostClient = createHostClient(options.internalUrl)
  const current = new AsyncLocalStorage<Invocation>()
  const db = createDbClient(httpDbSender(options.internalUrl, () => current.getStore()?.id))
  const ha = createHaClient(httpHaSender(options.internalUrl, () => current.getStore()?.id))
  const devices = createDeviceClient(httpDeviceSender(options.internalUrl, () => current.getStore()?.id))
  const secrets = Object.freeze({ ...options.secrets })

  // Console output inside an invocation belongs to it. Output outside any
  // invocation (module top level, stray timers) goes to the runner's own
  // stdout, which the host records as runtime logs.
  const original = { ...console }
  for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
    const fallback = (original as unknown as Record<string, (...args: unknown[]) => void>)[method]
    ;(console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (...args: unknown[]) => {
      const invocation = current.getStore()
      if (invocation) client.log(invocation.id, level, format(...args))
      else fallback?.apply(console, args)
    }
  }

  const modules = new Map<string, Promise<Handler>>()
  function load(handler: string): Promise<Handler> {
    let loaded = modules.get(handler)
    if (!loaded) {
      const url = pathToFileURL(join(options.appDir, handlerModulePath(handler))).href
      loaded = import(url).then((mod: { default?: unknown }) => {
        if (typeof mod.default !== 'function') {
          throw new Error(`${handler} does not default-export a handler function`)
        }
        return mod.default as Handler
      })
      // A failed import is retried on the next invocation instead of being cached.
      loaded.catch(() => modules.delete(handler))
      modules.set(handler, loaded)
    }
    return loaded
  }

  async function invoke(message: InvokeRequest): Promise<InvokeResult> {
    const { invocation } = message
    const log = Object.fromEntries(
      (['debug', 'info', 'warn', 'error'] as const).map((level) => [
        level,
        (...args: unknown[]) => client.log(invocation.id, level, format(...args)),
      ]),
    ) as Logger
    try {
      const handler = await load(message.handler)
      const ctx: Context = {
        invocation,
        request: message.request ? toRequest(message.request) : undefined,
        params: message.params ?? {},
        payload: message.payload,
        fetch: globalThis.fetch.bind(globalThis),
        log,
        db,
        ha,
        device: devices.device,
        devices: devices.devices,
        secrets,
      }
      const value = await current.run(invocation, () => handler(ctx))
      return { ok: true, response: await toSerializedResponse(value) }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    } finally {
      await client.flush()
    }
  }

  for (const handler of options.handlers) await load(handler)

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ready') return send(res, 200, { ok: true })
    if (req.method !== 'POST' || req.url !== '/invoke') return send(res, 404, { error: 'not found' })
    readBody(req)
      .then((body) => invoke(JSON.parse(body) as InvokeRequest))
      .then(
        (result) => send(res, 200, result),
        (err: unknown) => send(res, 400, { ok: false, error: serializeError(err) }),
      )
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))

  return {
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await client.flush()
      Object.assign(console, original)
    },
  }
}
