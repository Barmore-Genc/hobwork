import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createTestHost } from './test-host.ts'
import { startTestApp } from './test-web.ts'

let app: Awaited<ReturnType<typeof startTestApp>>
let host: ReturnType<typeof createTestHost>
let webDist: string

beforeEach(async () => {
  host = createTestHost()
  webDist = mkdtempSync(join(tmpdir(), 'hobwork-web-'))
  mkdirSync(join(webDist, 'assets'))
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Hobwork</title>')
  writeFileSync(join(webDist, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(webDist, 'favicon.svg'), '<svg/>')
  app = await startTestApp(host, { web: { webDist } })
})

afterEach(async () => {
  await app.close()
  host.dispose()
  rmSync(webDist, { recursive: true, force: true })
})

test('GET /api/health', async () => {
  expect(await (await fetch(`${app.base}/api/health`)).json()).toEqual({ ok: true })
})

test('unknown API paths return 404 instead of the web UI', async () => {
  const res = await fetch(`${app.base}/api/nope`)
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toBe('application/json')
})

test('serves the built web UI with a fallback for client-side routes', async () => {
  for (const path of ['/', '/projects/filament', '/agents']) {
    const res = await fetch(`${app.base}${path}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('<title>Hobwork</title>')
  }
  const asset = await fetch(`${app.base}/assets/index-abc123.js`)
  expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(asset.headers.get('cache-control')).toContain('immutable')
  expect((await fetch(`${app.base}/favicon.svg`)).headers.get('content-type')).toBe('image/svg+xml')
  expect((await fetch(`${app.base}/assets/missing.js`)).status).toBe(404)
})

test('conditional requests get 304', async () => {
  const first = await fetch(`${app.base}/favicon.svg`)
  const etag = first.headers.get('etag')!
  expect((await fetch(`${app.base}/favicon.svg`, { headers: { 'if-none-match': etag } })).status).toBe(304)
})

test('paths cannot leave the web UI directory', async () => {
  for (const path of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/package.json', '/assets/..%2f..%2fx.js']) {
    const res = await fetch(`${app.base}${path}`)
    expect(await res.text()).not.toContain('root:')
    expect([200, 404]).toContain(res.status)
  }
})

test('serves the theme stylesheet and its fonts', async () => {
  const css = await fetch(`${app.base}/theme/theme.css`)
  expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
  const text = await css.text()
  expect(text).toContain('--hw-surface')
  const font = /url\((\/theme\/fonts\/[^)]+)\)/.exec(text)?.[1]
  expect(font).toBeTruthy()
  const res = await fetch(`${app.base}${font}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('font/woff2')
  expect((await fetch(`${app.base}/theme/fonts/../package.json`)).status).not.toBe(200)
})

test('without a built web UI the theme is still served', async () => {
  const bare = await startTestApp(host)
  try {
    expect((await fetch(`${bare.base}/theme/theme.css`)).status).toBe(200)
    expect((await fetch(`${bare.base}/projects`)).status).toBe(404)
  } finally {
    await bare.close()
  }
})
