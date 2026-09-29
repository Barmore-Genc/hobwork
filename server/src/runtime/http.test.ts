import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { createRuntimeHttp } from './http.ts'
import type { Runtime } from './runtime.ts'
import { rotateBranchWebhookToken, rotateWebhookToken } from './webhooks.ts'

let host: ReturnType<typeof createTestHost>
let server: Server
let base: string
let resolved: string[]

beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
  resolved = []
  const runtime = {
    webhookExists: async () => true,
    invoke: async () => ({
      ok: true,
      invocationId: 1,
      response: { status: 200, headers: [], body: Buffer.from('ok').toString('base64') },
    }),
  } as unknown as Runtime
  const handle = createRuntimeHttp(host, runtime, {
    authorizeRoute: () => 'allowed',
    appOrigin: () => undefined,
    resolvePreview: async (label) => {
      resolved.push(label)
      return label === 'add-spools--filament' ? { project: 'filament', branch: 'add-spools' } : undefined
    },
  })
  server = createServer((req, res) => {
    const { pathname, search } = new URL(req.url ?? '/', 'http://localhost')
    if (!handle(req, res, pathname, search)) res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  host.dispose()
})

test('a preview webhook request without a valid token resolves no branch label', async () => {
  const branchToken = rotateBranchWebhookToken(host, 'filament', 'add-spools', 'scanned')
  const mainToken = rotateWebhookToken(host, 'filament', 'scanned')
  const hook = (target: string, token: string) => fetch(`${base}/hooks/${target}/scanned/${token}`, { method: 'POST' })

  expect((await hook('add-spools--filament', 'wrong')).status).toBe(404)
  expect((await hook('add-spools--filament', mainToken)).status).toBe(404)
  expect((await hook('nope--missing', branchToken)).status).toBe(404)
  expect(resolved).toEqual([])

  expect((await hook('add-spools--filament', branchToken)).status).toBe(200)
  expect(resolved).toEqual(['add-spools--filament'])
})

test('a token for another branch does not open a preview', async () => {
  const other = rotateBranchWebhookToken(host, 'filament', 'other', 'scanned')
  const res = await fetch(`${base}/hooks/add-spools--filament/scanned/${other}`, { method: 'POST' })
  expect(res.status).toBe(404)
})
