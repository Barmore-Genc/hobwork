import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { openHostDb } from './db.ts'

let base: string
let close: () => Promise<void>
let db: ReturnType<typeof openHostDb>

beforeEach(async () => {
  db = openHostDb(':memory:')
  const server = createApp(db)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise((resolve) => server.close(() => resolve()))
})

afterEach(async () => {
  await close()
  db.close()
})

test('GET /api/projects returns projects in the shape the web UI expects', async () => {
  expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([])
  db.prepare('INSERT INTO projects (name) VALUES (?)').run('filament')
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
