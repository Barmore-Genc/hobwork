import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import type { SearchResult } from '../../packages/sdk/src/workspace-tools/search.ts'
import { listCommittedFiles, readCommittedFile, type ReadResult, type CommittedSearch } from './committed-files.ts'
import { repoPath, type Host } from './host.ts'
import { DEFAULT_BRANCH, ProjectError } from './projects.ts'
import { branchHead, validateBranchName } from './repo.ts'
import type { CommittedSearchJob } from './search-worker.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from './workspaces.ts'

const SEARCH_TIMEOUT_MS = 10_000

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code
}

export const MAX_CONFIG_FILE_BYTES = 1024 * 1024

// For the few files the host reads out of a checkout itself (hobwork.json and
// package.json, when a workspace VM starts). O_NONBLOCK keeps a FIFO from
// blocking the open, and the size cap keeps the guest from making the host
// read an unbounded file.
export async function readRegularFile(path: string, label: string, maxBytes = MAX_CONFIG_FILE_BYTES): Promise<string> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    if (isErrno(err, 'ELOOP') || isErrno(err, 'EMLINK')) throw new ProjectError(`${label} is a symlink`)
    throw err
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new ProjectError(`${label} is not a regular file`)
    if (stat.size > maxBytes) throw new ProjectError(`${label} is larger than ${maxBytes} bytes`)
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) throw new ProjectError(`${label} is larger than ${maxBytes} bytes`)
    return buffer.toString('utf8', 0, length)
  } finally {
    await handle.close()
  }
}

export type FileList = { entries: string[]; truncated: boolean }

// Who is reading. Read-only credentials only ever see committed files.
export type FileAccess = { readOnly: boolean }

type Committed = { repo: string; commit: string }

// The file tools of the MCP server. Reads come from the project repo's git
// objects, without a workspace VM, when the branch is main, the credential is
// read-only, or the branch's workspace has no uncommitted changes. Otherwise
// they, and all changes, run in the workspace VM, so the host never opens files
// the VM can write.
export function createFileTools(
  host: Host,
  workspaces: Pick<WorkspaceManager<ExecWorkspaceVm>, 'files' | 'isCommitted'>,
  { searchTimeoutMs = SEARCH_TIMEOUT_MS }: { searchTimeoutMs?: number } = {},
) {
  async function committed(project: string, branch: string, access: FileAccess): Promise<Committed | undefined> {
    validateBranchName(branch)
    if (branch !== DEFAULT_BRANCH && !access.readOnly && !(await workspaces.isCommitted(project, branch))) {
      return undefined
    }
    const commit = await branchHead(host, project, branch)
    if (!commit) throw new ProjectError(`Branch "${branch}" does not exist in ${project}`)
    return { repo: repoPath(host, project), commit }
  }

  function assertWritable(branch: string): void {
    if (branch === DEFAULT_BRANCH) {
      throw new ProjectError(
        `${DEFAULT_BRANCH} is the deployed version and changes only by merging a branch. Create a branch with create_branch and make the change there`,
      )
    }
  }

  async function read(project: string, branch: string, path: string, access: FileAccess): Promise<ReadResult> {
    const source = await committed(project, branch, access)
    if (source) return readCommittedFile(source.repo, source.commit, path)
    const result = await workspaces.files(project, branch, { op: 'read', path })
    if (result.op !== 'read') throw new Error('Unexpected file tool answer')
    return result.binary
      ? { binary: true, size: result.size }
      : { binary: false, content: result.content, size: result.size }
  }

  async function write(project: string, branch: string, path: string, content: string): Promise<{ created: boolean }> {
    assertWritable(branch)
    const result = await workspaces.files(project, branch, { op: 'write', path, content })
    if (result.op !== 'write') throw new Error('Unexpected file tool answer')
    return { created: result.created }
  }

  async function edit(
    project: string,
    branch: string,
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): Promise<{ replacements: number }> {
    assertWritable(branch)
    const result = await workspaces.files(project, branch, { op: 'edit', path, oldString, newString, replaceAll })
    if (result.op !== 'edit') throw new Error('Unexpected file tool answer')
    return { replacements: result.replacements }
  }

  async function remove(project: string, branch: string, path: string): Promise<void> {
    assertWritable(branch)
    await workspaces.files(project, branch, { op: 'delete', path })
  }

  async function list(
    project: string,
    branch: string,
    path: string,
    recursive: boolean,
    access: FileAccess,
  ): Promise<FileList> {
    const source = await committed(project, branch, access)
    if (source) return listCommittedFiles(source.repo, source.commit, path, recursive)
    const result = await workspaces.files(project, branch, { op: 'list', path, recursive })
    if (result.op !== 'list') throw new Error('Unexpected file tool answer')
    return { entries: result.entries, truncated: result.truncated }
  }

  async function search(
    project: string,
    branch: string,
    request: Omit<CommittedSearch, 'ignoreCase'> & { ignoreCase: boolean },
    access: FileAccess,
  ): Promise<SearchResult> {
    try {
      new RegExp(request.pattern, request.ignoreCase ? 'i' : '')
    } catch (err) {
      throw new ProjectError(`Invalid regular expression: ${(err as Error).message}`)
    }
    const timedOut = () =>
      new ProjectError(`Search timed out after ${searchTimeoutMs / 1000}s. Narrow the path or glob, or simplify the pattern`)
    const source = await committed(project, branch, access)
    if (source) return searchInWorker({ repo: source.repo, commit: source.commit, request }, searchTimeoutMs, timedOut)
    try {
      const result = await workspaces.files(project, branch, { op: 'search', ...request }, { timeoutMs: searchTimeoutMs })
      if (result.op !== 'search') throw new Error('Unexpected file tool answer')
      return result
    } catch (err) {
      if (err instanceof ProjectError && err.message.startsWith('The workspace did not answer')) throw timedOut()
      throw err
    }
  }

  return { read, write, edit, remove, list, search, assertWritable }
}

// Patterns come from agents. Matching in a worker with a deadline keeps a
// catastrophically backtracking pattern from blocking the host.
function searchInWorker(job: CommittedSearchJob, timeoutMs: number, timedOut: () => Error): Promise<SearchResult> {
  const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { workerData: job })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(timedOut())
    }, timeoutMs)
    worker.once('message', (message: { ok: true; result: SearchResult } | { ok: false; error: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      if (message.ok) resolve(message.result)
      else reject(new ProjectError(message.error))
    })
    worker.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
