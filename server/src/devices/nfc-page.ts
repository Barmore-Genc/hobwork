import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { Auth } from '../auth/auth.ts'
import { redirect } from '../http.ts'
import type { Devices } from './devices.ts'
import { NFC_TAG_ID, nfcTagProject } from './store.ts'

export const NFC_PATH = /^\/nfc\/([^/]+)$/

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(res: ServerResponse, status: number, heading: string, body: string) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NFC tag · Hobwork</title>
<link rel="stylesheet" href="/theme/theme.css">
<style>
body { margin: 0; background: var(--hw-bg); color: var(--hw-fg); font-family: var(--hw-font-sans); }
main { max-width: 28rem; margin: 0 auto; padding: 4rem 1rem; }
h1 { font-family: var(--hw-font-display); font-size: 1.5rem; margin: 0 0 1rem; }
p { color: var(--hw-muted); line-height: 1.5; }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
a, button { font: inherit; border-radius: var(--hw-radius-md); padding: 0.6rem 1rem; text-decoration: none; cursor: pointer; }
.primary { background: var(--hw-accent); color: var(--hw-on-accent); border: 0; }
.secondary { background: var(--hw-surface-raised); color: var(--hw-fg); border: 1px solid var(--hw-border); }
</style>
</head>
<body><main><h1>${escapeHtml(heading)}</h1>${body}</main></body>
</html>
`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'",
    'x-frame-options': 'DENY',
  })
  res.end(html)
}

function appLink(tag: string): string {
  return `<a class="secondary" href="hobwork://nfc/${escapeHtml(tag)}">Open in the Hobwork app</a>`
}

// The page a Hobwork NFC tag opens in a browser, when the app is not set up
// to open the tag's link itself (see "nfc" in docs/architecture.md). Loading
// it counts as a scan for a signed-in person.
export function createNfcPage(options: { db: DatabaseSync; auth: Auth; publicUrl: string; devices: Devices }) {
  const { db, auth, publicUrl, devices } = options

  function sameSite(req: IncomingMessage): boolean {
    const site = req.headers['sec-fetch-site']
    const origin = req.headers.origin
    return (site === undefined || site === 'none' || site === 'same-origin') && (origin === undefined || origin === publicUrl)
  }

  return async (req: IncomingMessage, res: ServerResponse, tag: string, search: URLSearchParams): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' }).end()
      return
    }
    const project = NFC_TAG_ID.test(tag) ? nfcTagProject(db, tag) : undefined
    if (!project) {
      page(res, 404, 'Unknown tag', '<p>This tag does not belong to a hob on this Hobwork host.</p>')
      return
    }
    const path = `/nfc/${tag}`
    const user = auth.currentUser(req)
    if (!user) {
      page(
        res,
        200,
        'Hobwork tag',
        `<p>Open the tag in the Hobwork app, or sign in to run it here.</p><div class="actions">${appLink(tag)}<a class="primary" href="/login?returnTo=${encodeURIComponent(path)}">Sign in</a></div>`,
      )
      return
    }
    if (req.method === 'GET' && search.has('scanned')) {
      page(res, 200, 'Tag scanned', `<p>${escapeHtml(project)} got the scan.</p><div class="actions">${appLink(tag)}</div>`)
      return
    }
    // A page on another site could send the person here; the scan then waits
    // for a tap.
    if (!sameSite(req) || req.method === 'HEAD') {
      page(
        res,
        200,
        'Hobwork tag',
        `<p>This tag belongs to ${escapeHtml(project)}.</p><div class="actions"><form method="post" action="${escapeHtml(path)}"><button class="primary" type="submit">Run it</button></form>${appLink(tag)}</div>`,
      )
      return
    }
    await devices.nfcScanned(tag, null)
    // Reloading the result does not scan again.
    redirect(res, `${path}?scanned`)
  }
}
