import type { IncomingMessage, ServerResponse } from 'node:http'

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Send the request body as application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'Request body is too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
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
