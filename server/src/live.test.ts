import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { createAuth } from './auth/auth.ts'
import { deleteSession } from './auth/sessions.ts'
import { publishChange } from './changes.ts'
import { CLOSE_SIGNED_OUT, createLiveSockets, LIVE_SOCKET_PATH, type LiveMessage, type LiveSockets } from './live.ts'
import { createProject } from './projects.ts'
import { createTestHost } from './test-host.ts'
import { signedIn, startTestApp, TEST_PUBLIC_URL } from './test-web.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string
let sockets: LiveSockets | undefined
let server: Server | undefined
const clients: WebSocket[] = []

beforeEach(async () => {
  host = createTestHost()
  cookie = signedIn(host).cookie
  app = await startTestApp(host)
})

afterEach(async () => {
  for (const client of clients.splice(0)) if (client.readyState === WebSocket.OPEN) client.terminate()
  sockets?.close()
  sockets = undefined
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  await app.close()
  host.dispose()
})

function connect(base: string, headers: Record<string, string>) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${LIVE_SOCKET_PATH}`, { headers })
  clients.push(ws)
  const messages: LiveMessage[] = []
  let waiting: (() => void) | undefined
  ws.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()) as LiveMessage)
    waiting?.()
  })
  return {
    ws,
    messages,
    opened: new Promise<void>((resolve) => ws.once('open', () => resolve())),
    refused: new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))),
    closed: new Promise<number>((resolve) => ws.once('close', (code) => resolve(code))),
    next: () => new Promise<void>((resolve) => (waiting = resolve)),
  }
}

test('refuses connections without a session or from another origin', async () => {
  expect(await connect(app.base, { origin: TEST_PUBLIC_URL }).refused).toBe(401)
  expect(await connect(app.base, { origin: TEST_PUBLIC_URL, cookie: 'hobwork_session=forged' }).refused).toBe(401)
  expect(await connect(app.base, { cookie }).refused).toBe(403)
  expect(await connect(app.base, { cookie, origin: 'http://filament.apps.hobwork.test' }).refused).toBe(403)
})

test('sends what changed, once per batch, to every signed-in page', async () => {
  const pages = [cookie, signedIn(host).cookie].map((session) => connect(app.base, { cookie: session, origin: TEST_PUBLIC_URL }))
  await Promise.all(pages.map((page) => page.opened))
  const arrived = pages.map((page) => page.next())
  await createProject(host, 'filament')
  publishChange(host.db, { kind: 'projects' }, { kind: 'agents' })
  await Promise.all(arrived)
  for (const page of pages) {
    expect(page.messages).toEqual([
      {
        type: 'changes',
        changes: [{ kind: 'project', project: 'filament' }, { kind: 'projects' }, { kind: 'agents' }],
      },
    ])
  }
})

test('closes the socket once the session ends', async () => {
  const auth = createAuth({ db: host.db, publicUrl: TEST_PUBLIC_URL, allowlist: { emails: ['kaan@example.com'], subjects: [] } })
  sockets = createLiveSockets({ db: host.db, auth, publicUrl: TEST_PUBLIC_URL, pingIntervalMs: 50 })
  server = createServer()
  server.on('upgrade', (req, socket, head) => {
    if (!sockets!.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const page = connect(base, { cookie, origin: TEST_PUBLIC_URL })
  await page.opened
  deleteSession(host.db, cookie.split('=')[1]!)
  expect(await page.closed).toBe(CLOSE_SIGNED_OUT)
})

test('closing the server ends open sockets', async () => {
  const page = connect(app.base, { cookie, origin: TEST_PUBLIC_URL })
  await page.opened
  await app.close()
  expect(await page.closed).toBe(1006)
  app = await startTestApp(host)
})
