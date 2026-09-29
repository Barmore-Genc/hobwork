import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, sep } from 'node:path'
import { fileStats, sendFile, within } from '../static.ts'

// Project UIs share the Hobwork origin, so only Hobwork itself may frame them.
const UI_HEADERS = {
  'content-security-policy': "frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
}

// dist/ also holds the handler bundles, which are not part of the UI.
const PRIVATE_DIRS = ['handlers']

function sendText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { ...UI_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`${text}\n`)
}

// The page is served for every client-side route under /p/<project>/, so
// relative URLs (./assets/..., api/...) must resolve against the project root
// rather than the current path.
function withBase(html: string, base: string): string {
  if (/<base[\s>]/i.test(html)) return html
  const tag = `<base href="${base}">`
  const head = /<head(\s[^>]*)?>/i.exec(html)
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html
}

function sendIndex(req: IncomingMessage, res: ServerResponse, build: string, project: string, base: string) {
  const path = join(build, 'index.html')
  if (!fileStats(path)) return sendText(res, 404, `${project} has no app to show.`)
  const html = Buffer.from(withBase(readFileSync(path, 'utf8'), base))
  res.writeHead(200, {
    ...UI_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': html.length,
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : html)
}

// Serves the deployed build's UI at <base><rest>. `base` is the project's URL
// prefix (/p/<project>/), `rest` the still encoded path after it.
export function serveProjectUi(
  req: IncomingMessage,
  res: ServerResponse,
  options: { project: string; base: string; rest: string; build: string },
) {
  const { project, base, rest, build } = options
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  if (rest === '' || rest === 'index.html') return sendIndex(req, res, build, project, base)
  const path = within(build, `/${rest}`)
  const hidden = path && PRIVATE_DIRS.some((dir) => path === join(build, dir) || path.startsWith(join(build, dir) + sep))
  const stats = path && !hidden ? fileStats(path) : undefined
  if (path && stats) {
    // Vite puts a content hash in every file name under assets/.
    const immutable = rest.startsWith('assets/')
    sendFile(req, res, path, stats, immutable ? 'private, max-age=31536000, immutable' : 'no-cache', UI_HEADERS)
    return
  }
  if (!path || extname(rest) !== '') return sendText(res, 404, 'Not found')
  sendIndex(req, res, build, project, base)
}
