import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, sep } from 'node:path'
import { fileStats, sendFile, within } from '../static.ts'

// Only the Hobwork web UI may frame a project UI.
export function uiHeaders(hobworkOrigin: string): Record<string, string> {
  return {
    'content-security-policy': `frame-ancestors ${hobworkOrigin}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  }
}

// dist/ also holds the handler bundles, which are not part of the UI.
const PRIVATE_DIRS = ['handlers']

export function sendUiText(res: ServerResponse, hobworkOrigin: string, status: number, text: string) {
  res.writeHead(status, { ...uiHeaders(hobworkOrigin), 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`${text}\n`)
}

// The page is served for every client-side route, so relative URLs
// (./assets/..., api/...) must resolve against the app's root rather than the
// current path.
function withBase(html: string, base: string): string {
  if (/<base[\s>]/i.test(html)) return html
  const tag = `<base href="${base}">`
  const head = /<head(\s[^>]*)?>/i.exec(html)
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html
}

function sendIndex(req: IncomingMessage, res: ServerResponse, options: UiOptions) {
  const { build, project, hobworkOrigin } = options
  const path = join(build, 'index.html')
  if (!fileStats(path)) return sendUiText(res, hobworkOrigin, 404, `${project} has no app to show.`)
  const html = Buffer.from(withBase(readFileSync(path, 'utf8'), '/'))
  res.writeHead(200, {
    ...uiHeaders(hobworkOrigin),
    'content-type': 'text/html; charset=utf-8',
    'content-length': html.length,
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : html)
}

type UiOptions = { project: string; build: string; hobworkOrigin: string }

// Serves a build's UI at the root of its app origin. `rest` is the still
// encoded path without the leading slash.
export function serveProjectUi(req: IncomingMessage, res: ServerResponse, options: UiOptions & { rest: string }) {
  const { rest, build, hobworkOrigin } = options
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  if (rest === '' || rest === 'index.html') return sendIndex(req, res, options)
  const path = within(build, `/${rest}`)
  const hidden = path && PRIVATE_DIRS.some((dir) => path === join(build, dir) || path.startsWith(join(build, dir) + sep))
  const stats = path && !hidden ? fileStats(path) : undefined
  if (path && stats) {
    // Vite puts a content hash in every file name under assets/.
    const immutable = rest.startsWith('assets/')
    sendFile(req, res, path, stats, immutable ? 'private, max-age=31536000, immutable' : 'no-cache', uiHeaders(hobworkOrigin))
    return
  }
  if (!path || extname(rest) !== '') return sendUiText(res, hobworkOrigin, 404, 'Not found')
  sendIndex(req, res, options)
}
