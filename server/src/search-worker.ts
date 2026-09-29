import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { searchCommittedFiles, type CommittedSearch } from './committed-files.ts'

export type CommittedSearchJob = { repo: string; commit: string; request: CommittedSearch }

// Runs in a worker so the caller can stop a pattern that backtracks forever.
if (!isMainThread && parentPort) {
  const job = workerData as CommittedSearchJob
  try {
    parentPort.postMessage({ ok: true, result: await searchCommittedFiles(job.repo, job.commit, job.request) })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
