import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createProject } from './projects.ts'
import { createTestHost } from './test-host.ts'

let base: string
let close: () => Promise<void>
let host: ReturnType<typeof createTestHost>

beforeEach(async () => {
  host = createTestHost()
  const server = createApp(host)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise((resolve) => server.close(() => resolve()))
})

afterEach(async () => {
  await close()
  host.dispose()
})

test('GET /api/projects returns projects in the shape the web UI expects', async () => {
  expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([])
  await createProject(host, 'filament')
  expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([
    { name: 'filament', defaultBranch: 'main' },
  ])
})

test('GET /api/health', async () => {
  expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true })
})

test('unknown paths return 404', async () => {
  expect((await fetch(`${base}/nope`)).status).toBe(404)
})
