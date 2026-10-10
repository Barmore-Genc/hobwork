import { useEffect, useRef } from 'react'

// What the host says changed. Pages load what they show again when a change
// concerns them (see "Live updates" in docs/architecture.md).
export type Change =
  | { kind: 'projects' }
  | { kind: 'project'; project: string }
  | { kind: 'invocations'; project: string; id: number }
  | { kind: 'logs'; project: string }
  | { kind: 'branches'; project: string }
  | { kind: 'secrets' }
  | { kind: 'agents' }
  | { kind: 'devices' }
  | { kind: 'people' }
  | { kind: 'trash' }
  | { kind: 'backups' }

export type LiveFilter = (change: Change) => boolean

// null after reconnecting: anything may have changed while the socket was down.
type Listener = (changes: Change[] | null) => void

const MIN_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000
// Keeps the socket while one page replaces another.
const IDLE_CLOSE_MS = 10_000
// Pages load again at most this often, however busy the host is.
const THROTTLE_MS = 1000

const listeners = new Set<Listener>()
let socket: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined
let failures = 0
let wasOpen = false

function emit(changes: Change[] | null) {
  for (const listener of [...listeners]) listener(changes)
}

function connect() {
  clearTimeout(retryTimer)
  retryTimer = undefined
  const url = new URL('/api/live', window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(url)
  socket = ws
  ws.onopen = () => {
    failures = 0
    if (wasOpen) emit(null)
    wasOpen = true
  }
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { type?: string; changes?: Change[] }
      if (message.type === 'changes' && Array.isArray(message.changes)) emit(message.changes)
    } catch {}
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    if (listeners.size) scheduleRetry()
  }
}

function scheduleRetry() {
  const delay = Math.min(MIN_RETRY_MS * 2 ** failures, MAX_RETRY_MS)
  failures++
  // Jitter, so pages in several tabs do not all reconnect at once after a host restart.
  retryTimer = setTimeout(connect, delay * (0.5 + Math.random() / 2))
}

function disconnect() {
  clearTimeout(retryTimer)
  retryTimer = undefined
  const ws = socket
  socket = null
  wasOpen = false
  ws?.close()
}

// A laptop waking up or getting its network back should not wait for the backoff.
function reconnectNow() {
  if (listeners.size && !socket && document.visibilityState === 'visible') connect()
}
window.addEventListener('online', reconnectNow)
document.addEventListener('visibilitychange', reconnectNow)

// Calls the listener with each batch of changes, and with null after the
// connection comes back.
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener)
  clearTimeout(idleTimer)
  if (!socket && retryTimer === undefined) connect()
  return () => {
    listeners.delete(listener)
    if (!listeners.size) idleTimer = setTimeout(disconnect, IDLE_CLOSE_MS)
  }
}

// Calls onChange when the host reports a change the filter accepts, or after
// the connection comes back. Without a filter it does nothing.
export function useLive(filter: LiveFilter | undefined, onChange: () => void) {
  const latest = useRef({ filter, onChange })
  useEffect(() => {
    latest.current = { filter, onChange }
  })
  const enabled = filter !== undefined

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending = false
    const fire = () => {
      pending = false
      latest.current.onChange()
      timer = setTimeout(() => {
        timer = undefined
        if (pending) fire()
      }, THROTTLE_MS)
    }
    const unsubscribe = subscribeLive((changes) => {
      const { filter } = latest.current
      if (!filter || (changes && !changes.some(filter))) return
      if (timer === undefined) fire()
      else pending = true
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [enabled])
}

// Filters for what the common pages show.
export const projectsChanged: LiveFilter = (change) => change.kind === 'projects' || change.kind === 'project'

export function projectChanged(project: string): LiveFilter {
  return (change) =>
    change.kind === 'secrets' || ((change.kind === 'project' || change.kind === 'invocations') && change.project === project)
}

export function kindChanged(kind: Change['kind'], project?: string): LiveFilter {
  return (change) => change.kind === kind && (project === undefined || !('project' in change) || change.project === project)
}

export function branchesChanged(project: string): LiveFilter {
  return (change) => (change.kind === 'branches' || change.kind === 'invocations') && change.project === project
}

// Restoring needs another name while a project has the old one.
export const trashChanged: LiveFilter = (change) => change.kind === 'trash' || change.kind === 'projects'
