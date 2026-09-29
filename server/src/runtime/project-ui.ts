import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, sep } from 'node:path'
import { FAVICON_SIZE, ICONS_DIR, iconFile } from '../../../packages/sdk/src/icons/icon.ts'
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

export const ICONS_PREFIX = `/${ICONS_DIR}/`
export const MANIFEST_PATH = '/_hobwork/manifest.webmanifest'

// The pipeline renders icons into the build (packages/sdk/src/icons/). Builds
// from before that, or of a branch whose icon is wrong, have none.
function hasIcons(build: string): boolean {
  return fileStats(join(build, ICONS_DIR, iconFile(FAVICON_SIZE))) !== undefined
}

const ICON_LINKS =
  `<link rel="icon" type="image/png" sizes="${FAVICON_SIZE}x${FAVICON_SIZE}" href="${ICONS_PREFIX}${iconFile(FAVICON_SIZE)}">` +
  `<link rel="apple-touch-icon" href="${ICONS_PREFIX}${iconFile(180)}">` +
  `<link rel="manifest" href="${MANIFEST_PATH}">`

// The page is served for every client-side route, so relative URLs
// (./assets/..., api/...) must resolve against the app's root rather than the
// current path. Icon links go first, so the page's own links win.
function withHead(html: string, options: { base: string; icons: boolean }): string {
  const tags = (/<base[\s>]/i.test(html) ? '' : `<base href="${options.base}">`) + (options.icons ? ICON_LINKS : '')
  const head = /<head(\s[^>]*)?>/i.exec(html)
  return head ? html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length) : tags + html
}

function sendIndex(req: IncomingMessage, res: ServerResponse, options: UiOptions) {
  const { build, project, hobworkOrigin } = options
  const path = join(build, 'index.html')
  if (!fileStats(path)) return sendUiText(res, hobworkOrigin, 404, `${project} has no app to show.`)
  const html = Buffer.from(withHead(readFileSync(path, 'utf8'), { base: '/', icons: hasIcons(build) }))
  res.writeHead(200, {
    ...uiHeaders(hobworkOrigin),
    'content-type': 'text/html; charset=utf-8',
    'content-length': html.length,
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : html)
}

// Serves the icons and web manifest of a stored build. Browsers fetch the
// manifest without cookies, so these need no app session. They show nothing
// but the project's name and icon.
export function serveAppIcons(
  req: IncomingMessage,
  res: ServerResponse,
  options: { project: string; build: string | undefined; pathname: string; hobworkOrigin: string },
) {
  const { build, pathname, hobworkOrigin } = options
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  if (pathname === MANIFEST_PATH) {
    const sizes = build && hasIcons(build) ? [192, 512] : []
    const manifest = Buffer.from(
      JSON.stringify({
        name: options.project,
        short_name: options.project,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        icons: sizes.map((size) => ({ src: `${ICONS_PREFIX}${iconFile(size)}`, sizes: `${size}x${size}`, type: 'image/png' })),
      }),
    )
    res.writeHead(200, {
      ...uiHeaders(hobworkOrigin),
      'content-type': 'application/manifest+json',
      'content-length': manifest.length,
      'cache-control': 'no-cache',
    })
    res.end(req.method === 'HEAD' ? undefined : manifest)
    return
  }
  const path = build && within(join(build, ICONS_DIR), `/${pathname.slice(ICONS_PREFIX.length)}`)
  const stats = path ? fileStats(path) : undefined
  if (!path || !stats) return sendUiText(res, hobworkOrigin, 404, 'Not found')
  sendFile(req, res, path, stats, 'no-cache', uiHeaders(hobworkOrigin))
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
