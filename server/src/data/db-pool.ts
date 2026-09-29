import { Worker } from 'node:worker_threads'
import type { Execution } from '../../../packages/sdk/src/db/execute.ts'
import type { DbRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import type { WorkerMessage, WorkerRequest, WorkerResponse } from './db-worker.ts'

const DEFAULT_IDLE_MS = 5 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 30 * 1000
const COPY_TIMEOUT_MS = 10 * 60 * 1000

type Pending = { resolve: (response: WorkerResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

type Entry = {
  worker: Worker
  pending: Map<number, Pending>
  idleTimer?: NodeJS.Timeout
}

export class DbTimeoutError extends Error {}

// Worker threads keyed by DB file path. Each worker holds one connection.
export function createDbPool(options: { idleMs?: number; timeoutMs?: number } = {}) {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const entries = new Map<string, Entry>()
  let nextId = 1

  function drop(path: string, entry: Entry, err: Error) {
    if (entries.get(path) === entry) entries.delete(path)
    clearTimeout(entry.idleTimer)
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    entry.pending.clear()
  }

  function entryFor(path: string): Entry {
    const existing = entries.get(path)
    if (existing) return existing
    const worker = new Worker(new URL('./db-worker.ts', import.meta.url), { workerData: { path } })
    // A pending request keeps the host busy anyway; idle workers must not keep
    // a finished process alive.
    worker.unref()
    const entry: Entry = { worker, pending: new Map() }
    entries.set(path, entry)
    worker.on('message', (message: WorkerResponse) => {
      const pending = entry.pending.get(message.id)
      if (!pending) return
      entry.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve(message)
      armIdle(path, entry)
    })
    worker.on('error', (err) => drop(path, entry, err))
    worker.on('exit', () => drop(path, entry, new Error('The DB worker stopped')))
    return entry
  }

  function armIdle(path: string, entry: Entry) {
    clearTimeout(entry.idleTimer)
    if (entry.pending.size) return
    entry.idleTimer = setTimeout(() => void close(path), idleMs)
    entry.idleTimer.unref()
  }

  function send(path: string, message: WorkerMessage, timeout: number): Promise<WorkerResponse> {
    const entry = entryFor(path)
    clearTimeout(entry.idleTimer)
    const id = nextId++
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // SQLite cannot be interrupted from here, so the worker is abandoned
        // and the next request opens a new connection.
        drop(path, entry, new DbTimeoutError(`The query did not finish within ${timeout / 1000}s`))
        void entry.worker.terminate()
      }, timeout)
      entry.pending.set(id, { resolve, reject, timer })
      entry.worker.postMessage({ id, ...message } satisfies WorkerRequest)
    })
  }

  async function execute(path: string, request: DbRequest): Promise<Execution> {
    const response = await send(path, { request }, timeoutMs)
    if (!('response' in response)) throw new Error('The DB worker answered a query with something else')
    return { response: response.response, timings: response.timings }
  }

  // Writes a consistent copy of the DB at `path` to `to`.
  async function copy(path: string, to: string): Promise<void> {
    const response = await send(path, { copyTo: to }, COPY_TIMEOUT_MS)
    if ('error' in response) throw new Error(`Copying the DB failed: ${response.error}`)
  }

  async function close(path: string): Promise<void> {
    const entry = entries.get(path)
    if (!entry) return
    drop(path, entry, new Error('The DB was closed'))
    await entry.worker.terminate()
  }

  return {
    timeoutMs,
    execute,
    copy,
    close,
    async closeAll(): Promise<void> {
      await Promise.all([...entries.keys()].map(close))
    },
  }
}

export type DbPool = ReturnType<typeof createDbPool>
