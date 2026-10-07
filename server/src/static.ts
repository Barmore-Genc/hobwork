import { createReadStream, statSync, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve, sep } from 'node:path'

export const themeDir = resolve(import.meta.dirname, '../../packages/theme')
export const THEME_PREFIX = '/theme/'

const FONT_PACKAGES = ['@fontsource-variable/bricolage-grotesque', '@fontsource-variable/atkinson-hyperlegible-next']
const FONT_FILE = /^[a-z0-9-]+\.woff2$/

// The policy of the Hobwork web UI. It runs with the user's session, so it may
// load code only from its own origin. Project apps are on sibling origins of
// the same site: the web UI must not be framed by them, and it frames only
// them (`appsFrameSource`) and itself: an app without a session sends its
// frame through /auth/app on this origin to get one. Styles stay inline for
// React `style` props.
export function webUiPolicy(appsFrameSource?: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${appsFrameSource ? `'self' ${appsFrameSource}` : "'none'"}`,
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

// Every app origin is one label below the apps host, so this covers them all.
export function appsFrameSource(appsUrl: string): string {
  const url = new URL(appsUrl)
  return `${url.protocol}//*.${url.host}`
}

const NOSNIFF = { 'x-content-type-options': 'nosniff' }

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

export function fileStats(path: string): Stats | undefined {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats : undefined
  } catch {
    return undefined
  }
}

// The byte range a Range header asks for. Several ranges are answered with
// the whole file, which the header allows.
function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!match || (match[1] === '' && match[2] === '')) return undefined
  const [first, last] = [match[1]!, match[2]!]
  const start = first === '' ? Math.max(0, size - Number(last)) : Number(first)
  const end = first === '' || last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if ((first === '' && Number(last) === 0) || start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

// Sends a file with an ETag and byte ranges. `headers` may set the content
// type. With `handle`, the file is read from it (and it is closed), so a file
// replaced since `stats` was taken cannot be sent instead.
export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  stats: Stats,
  cacheControl: string,
  headers: Record<string, string> = {},
  handle?: FileHandle,
) {
  const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
  const done = () => void handle?.close().catch(() => {})
  if (req.headers['if-none-match'] === etag) {
    done()
    res.writeHead(304, { ...headers, etag, 'cache-control': cacheControl }).end()
    return
  }
  const ifRange = req.headers['if-range']
  const range = req.method === 'GET' && (ifRange === undefined || ifRange === etag) ? byteRange(req.headers.range, stats.size) : undefined
  const common = {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    ...headers,
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
    etag,
  }
  if (range === 'unsatisfiable') {
    done()
    res.writeHead(416, { ...common, 'content-range': `bytes */${stats.size}`, 'content-length': 0 }).end()
    return
  }
  const { start, end } = range ?? { start: 0, end: stats.size - 1 }
  res.writeHead(range ? 206 : 200, {
    ...common,
    'content-length': end - start + 1,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${stats.size}` } : {}),
  })
  if (req.method === 'HEAD' || stats.size === 0) {
    done()
    res.end()
    return
  }
  const stream = handle ? handle.createReadStream({ start, end }) : createReadStream(path, { start, end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

// Resolves a URL path inside `root`, or undefined when it would leave it.
export function within(root: string, pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const path = resolve(join(root, decoded))
  return path.startsWith(root + sep) ? path : undefined
}

// Serves the theme at stable URLs for the web UI and project UIs, and, when
// given webDist, the built web UI with a fallback to index.html for client-side routes. Returns false
// for requests it does not serve.
export function createStaticRoutes(options: { webDist?: string; appsUrl?: string }) {
  const webDist = options.webDist && resolve(options.webDist)
  const webUiHeaders = {
    ...NOSNIFF,
    'content-security-policy': webUiPolicy(options.appsUrl && appsFrameSource(options.appsUrl)),
  }
  const requireFromTheme = createRequire(join(themeDir, 'package.json'))
  const fontDirs = FONT_PACKAGES.map((pkg) => join(dirname(requireFromTheme.resolve(`${pkg}/package.json`)), 'files'))

  return (req: IncomingMessage, res: ServerResponse, pathname: string): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false

    if (pathname === `${THEME_PREFIX}theme.css`) {
      const path = join(themeDir, 'theme.css')
      sendFile(req, res, path, statSync(path), 'no-cache', NOSNIFF)
      return true
    }
    if (pathname.startsWith(`${THEME_PREFIX}fonts/`)) {
      const name = pathname.slice(`${THEME_PREFIX}fonts/`.length)
      if (!FONT_FILE.test(name)) return false
      for (const dir of fontDirs) {
        const stats = fileStats(join(dir, name))
        if (stats) {
          sendFile(req, res, join(dir, name), stats, 'public, max-age=604800', NOSNIFF)
          return true
        }
      }
      return false
    }

    if (!webDist) return false
    const path = within(webDist, pathname)
    const stats = path ? fileStats(path) : undefined
    if (path && stats) {
      // Vite puts a content hash in every file name under assets/.
      const immutable = pathname.startsWith('/assets/')
      sendFile(req, res, path, stats, immutable ? 'public, max-age=31536000, immutable' : 'no-cache', webUiHeaders)
      return true
    }
    if (extname(pathname) !== '') return false
    const index = join(webDist, 'index.html')
    const indexStats = fileStats(index)
    if (!indexStats) {
      res.writeHead(404, { ...NOSNIFF, 'content-type': 'text/plain; charset=utf-8' })
      res.end('The web UI is not built. Run "pnpm -C web build", or use the Vite dev server with "pnpm dev".\n')
      return true
    }
    sendFile(req, res, index, indexStats, 'no-cache', webUiHeaders)
    return true
  }
}
