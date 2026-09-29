import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// Answers a WebSocket upgrade request with an HTTP error instead.
export function refuseUpgrade(socket: Duplex, status: number, message: string) {
  const body = JSON.stringify({ error: message })
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
      'content-type: application/json\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'connection: close\r\n\r\n' +
      body,
  )
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'Request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Send the request body as application/json')
  }
  const body = await readBody(req, limit)
  try {
    return JSON.parse(body)
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
}

export async function readForm(req: IncomingMessage, limit = 64 * 1024): Promise<URLSearchParams> {
  if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    throw new HttpError(415, 'Send the request body as application/x-www-form-urlencoded')
  }
  return new URLSearchParams(await readBody(req, limit))
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (!cookies.has(name)) {
      try {
        cookies.set(name, decodeURIComponent(part.slice(eq + 1).trim()))
      } catch {}
    }
  }
  return cookies
}

export type CookieOptions = {
  maxAge: number
  secure: boolean
  path?: string
}

export function setCookie(res: ServerResponse, name: string, value: string, options: CookieOptions) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (options.secure) parts.push('Secure')
  res.appendHeader('set-cookie', parts.join('; '))
}

export function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { location, 'cache-control': 'no-store' })
  res.end()
}
