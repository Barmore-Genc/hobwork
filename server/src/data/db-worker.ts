// One worker thread per open project DB, so a slow handler query blocks that
// project's queries and not the host's event loop.
import { parentPort, workerData } from 'node:worker_threads'
import { createExecutor, type Execution } from '../../../packages/sdk/src/db/execute.ts'
import type { DbRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import { openDb } from '../db.ts'

export type WorkerMessage = { request: DbRequest } | { copyTo: string } | { close: true }

export type WorkerRequest = { id: number } & WorkerMessage

export type WorkerResponse = { id: number } & (Execution | { copied: true } | { closed: true } | { error: string })

const db = openDb((workerData as { path: string }).path)
db.enableDefensive(true)
// Triggers and views in a DB a migration produced cannot call unsafe functions.
db.exec('PRAGMA trusted_schema = OFF')
const { execute, asHost } = createExecutor(db)

function handle(message: WorkerRequest): WorkerResponse {
  if ('request' in message) return { id: message.id, ...execute(message.request) }
  if ('close' in message) {
    // Checkpoints and removes the WAL, so the file can be replaced.
    db.close()
    return { id: message.id, closed: true }
  }
  try {
    // A consistent snapshot, even while other connections write.
    asHost(() => db.prepare('VACUUM INTO ?').run(message.copyTo))
    return { id: message.id, copied: true }
  } catch (err) {
    return { id: message.id, error: (err as Error).message }
  }
}

parentPort?.on('message', (message: WorkerRequest) => {
  parentPort?.postMessage(handle(message))
})
