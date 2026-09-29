import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Auth } from './auth/auth.ts'
import { onChange, type Change } from './changes.ts'
import { refuseUpgrade } from './http.ts'

export const LIVE_SOCKET_PATH = '/api/live'
export const CLOSE_SIGNED_OUT = 4001
const PING_INTERVAL_MS = 30_000
// Changes within this window go out as one message, each once, so a handler
// writing many log lines does not make pages load them again for every line.
const BATCH_MS = 100

export type LiveMessage = { type: 'changes'; changes: Change[] }

export type LiveSockets = ReturnType<typeof createLiveSockets>

// Tells open web UI pages what changed (see "Live updates" in docs/architecture.md).
export function createLiveSockets(options: {
  db: DatabaseSync
  auth: Auth
  publicUrl: string
  pingIntervalMs?: number
  batchMs?: number
}) {
  const { db, auth, publicUrl } = options
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS
  const batchMs = options.batchMs ?? BATCH_MS
  // Pages send nothing.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 })
  const queues = new Set<(change: Change) => void>()
  const unsubscribe = onChange(db, (change) => {
    for (const queue of queues) queue(change)
  })

  function serve(ws: WebSocket, req: IncomingMessage) {
    const pending = new Map<string, Change>()
    let timer: NodeJS.Timeout | undefined
    let alive = true

    const flush = () => {
      timer = undefined
      if (ws.readyState !== ws.OPEN || !pending.size) return
      const message: LiveMessage = { type: 'changes', changes: [...pending.values()] }
      pending.clear()
      ws.send(JSON.stringify(message))
    }
    const queue = (change: Change) => {
      pending.set(JSON.stringify(change), change)
      timer ??= setTimeout(flush, batchMs)
    }
    queues.add(queue)

    const pinger = setInterval(() => {
      // Signing out or leaving the allowlist ends the session without a host
      // restart, so an open socket is checked again here.
      if (!auth.currentUser(req)) return ws.close(CLOSE_SIGNED_OUT, 'Signed out')
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, pingIntervalMs)

    ws.on('pong', () => {
      alive = true
    })
    ws.on('close', () => {
      queues.delete(queue)
      clearTimeout(timer)
      clearInterval(pinger)
    })
    ws.on('error', (err) => console.warn(`Live updates connection error: ${err.message}`))
  }

  return {
    // Returns false for upgrade requests to other paths.
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== LIVE_SOCKET_PATH) return false
      // Browsers send cookies with WebSockets from any page, project apps on
      // sibling origins included, and never block them by origin.
      if (req.headers.origin !== publicUrl) {
        refuseUpgrade(socket, 403, 'Connect from the Hobwork web UI')
        return true
      }
      if (!auth.currentUser(req)) {
        refuseUpgrade(socket, 401, 'Sign in to continue')
        return true
      }
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws, req))
      return true
    },
    close() {
      unsubscribe()
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
  }
}
