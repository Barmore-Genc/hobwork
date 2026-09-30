import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Socket } from 'node:net'
import { createInterface } from 'node:readline'

// In a workspace VM the token of the command a call belongs to is held by a
// root helper (see cli/broker.ts), which calls the host for the caller. Runtime
// VMs and the host's tests have no helper and send plain requests.
const BROKER = '/usr/local/bin/hobwork-broker'

export type InternalReply = { status: number; json(): Promise<unknown> }

type Pending = { resolve: (reply: InternalReply) => void; reject: (err: Error) => void }

let child: ChildProcess | undefined
let nextId = 1
const pending = new Map<number, Pending>()

function settle(id: number, action: (entry: Pending) => void): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  action(entry)
  if (pending.size === 0) idle()
}

// The helper's pipes are sockets. They only keep the process alive while a request waits.
function pipes(proc: ChildProcess | undefined): Socket[] {
  return [proc?.stdout, proc?.stdin].filter((pipe): pipe is Socket => pipe !== null && pipe !== undefined) as Socket[]
}

function idle(): void {
  for (const pipe of pipes(child)) pipe.unref()
}

function helper(): ChildProcess {
  if (child) return child
  const started = spawn('doas', [BROKER], { stdio: ['pipe', 'pipe', 'inherit'] })
  child = started
  createInterface({ input: started.stdout! }).on('line', (line) => {
    const message = JSON.parse(line) as { id: number; status: number; body: string }
    settle(message.id, ({ resolve }) => resolve({ status: message.status, json: async () => JSON.parse(message.body) }))
  })
  started.on('close', () => {
    if (child === started) child = undefined
    for (const id of pending.keys()) settle(id, ({ reject }) => reject(new Error('The session helper stopped')))
  })
  started.stdin?.on('error', () => {})
  started.on('error', (err) => {
    if (child === started) child = undefined
    for (const id of pending.keys()) settle(id, ({ reject }) => reject(new Error(`Could not start the session helper: ${err.message}`)))
  })
  started.unref()
  idle()
  return started
}

function viaHelper(path: string, body: string): Promise<InternalReply> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const proc = helper()
    pending.set(id, { resolve, reject })
    for (const pipe of pipes(proc)) pipe.ref()
    proc.stdin?.write(`${JSON.stringify({ id, method: 'POST', path, body })}\n`)
  })
}

export function internalPost(baseUrl: string, path: string, body: string): Promise<InternalReply> {
  const session = process.env.HOBWORK_SESSION
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (session) headers['x-hobwork-session'] = session
  else if (new URL(baseUrl).hostname === 'hobwork.internal' && existsSync(BROKER)) return viaHelper(path, body)
  return fetch(new URL(path, baseUrl), { method: 'POST', headers, body })
}
