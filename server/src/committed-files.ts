import { spawn } from 'node:child_process'
import { posix } from 'node:path'
import { MAX_READ_BYTES } from '../../packages/sdk/src/workspace-tools/files.ts'
import { MAX_SEARCH_FILE_BYTES, Searcher, type SearchRequest, type SearchResult } from '../../packages/sdk/src/workspace-tools/search.ts'
import { walk, type DirEntry } from '../../packages/sdk/src/workspace-tools/walk.ts'
import { git, GitError, gitEnv } from './git.ts'
import { ProjectError } from './projects.ts'

// File tools that read committed files from a project repo's git objects, the
// way the tools in the workspace VM read the checkout (see files.ts for when
// which is used). They only read the host's own bare repo.

const MAX_LIST_ENTRIES = 2000

// The same rules as the VM tools apply to paths, so both answer alike.
export function relativePath(path: string): string {
  if (path.includes('\0')) throw new ProjectError('Path must not contain NUL characters')
  if (path.startsWith('/')) {
    throw new ProjectError(`Path "${path}" must be relative to the hob root, e.g. "src/index.ts"`)
  }
  const normalized = posix.normalize(path)
  if (normalized === '..' || normalized.startsWith('../')) throw new ProjectError(`Path "${path}" is outside the hob`)
  if (normalized.split('/').some((part) => part === '.git')) {
    throw new ProjectError(`Path "${path}" is inside a .git directory`)
  }
  return normalized === '.' ? '' : normalized.replace(/\/$/, '')
}

async function objectType(repo: string, revision: string): Promise<'blob' | 'tree' | 'other' | undefined> {
  try {
    const type = (await git(['--git-dir', repo, 'cat-file', '-t', revision])).trim()
    return type === 'blob' || type === 'tree' ? type : 'other'
  } catch (err) {
    if (err instanceof GitError) return undefined
    throw err
  }
}

function revision(commit: string, rel: string): string {
  return rel ? `${commit}:${rel}` : `${commit}^{tree}`
}

async function entries(repo: string, tree: string): Promise<DirEntry<string>[]> {
  const out = await git(['--git-dir', repo, 'ls-tree', '-z', '-l', tree])
  const result: DirEntry<string>[] = []
  for (const record of out.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t')
    const [mode = '', type = '', sha = '', size = '-'] = record.slice(0, tab).split(/\s+/)
    const name = record.slice(tab + 1)
    if (type === 'tree') result.push({ name, kind: 'dir', loc: sha })
    else if (type === 'blob' && mode !== '120000') {
      result.push({ name, kind: 'file', loc: sha, size: size === '-' ? undefined : Number(size) })
    } else result.push({ name, kind: 'other', loc: sha })
  }
  return result
}

async function requireDirectory(repo: string, commit: string, path: string, rel: string): Promise<string> {
  const type = await objectType(repo, revision(commit, rel))
  if (!type) throw new ProjectError(`"${path}" does not exist`)
  if (type !== 'tree') throw new ProjectError(`"${path}" is not a directory`)
  return (await git(['--git-dir', repo, 'rev-parse', revision(commit, rel)])).trim()
}

export type ReadResult = { binary: false; content: string; size: number } | { binary: true; size: number }

export async function readCommittedFile(repo: string, commit: string, path: string): Promise<ReadResult> {
  const rel = relativePath(path)
  const type = rel ? await objectType(repo, revision(commit, rel)) : 'tree'
  if (!type) throw new ProjectError(`"${path}" does not exist`)
  if (type !== 'blob') throw new ProjectError(`"${path}" is a directory. Use list_files to see its contents`)
  const size = Number((await git(['--git-dir', repo, 'cat-file', '-s', revision(commit, rel)])).trim())
  if (size > MAX_READ_BYTES) {
    throw new ProjectError(
      `"${path}" is ${size} bytes, over the ${MAX_READ_BYTES} byte limit of the file tools. Use bash to read part of it, for example with sed -n`,
    )
  }
  const content = await git(['--git-dir', repo, 'cat-file', 'blob', revision(commit, rel)])
  if (content.slice(0, 8000).includes('\0')) return { binary: true, size }
  return { binary: false, content, size }
}

export async function listCommittedFiles(
  repo: string,
  commit: string,
  path: string,
  recursive: boolean,
): Promise<{ entries: string[]; truncated: boolean }> {
  const rel = relativePath(path)
  const tree = await requireDirectory(repo, commit, path, rel)
  const list: string[] = []
  let truncated = false
  await walk(tree, rel, {
    readDir: (loc) => entries(repo, loc),
    recursive,
    visit: (entry, name) => {
      if (list.length >= MAX_LIST_ENTRIES) {
        truncated = true
        return false
      }
      list.push(entry.kind === 'dir' ? `${name}/` : name)
      return true
    },
  })
  return { entries: list, truncated }
}

// One `git cat-file --batch` process answers requests for blobs one at a time.
class BlobReader {
  readonly #child
  #buffer = Buffer.alloc(0)
  #waiting: (() => void) | undefined
  #closed = false

  constructor(repo: string) {
    this.#child = spawn('git', ['--git-dir', repo, 'cat-file', '--batch'], { env: gitEnv() })
    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#waiting?.()
    })
    this.#child.stdin.on('error', () => {})
    this.#child.on('close', () => {
      this.#closed = true
      this.#waiting?.()
    })
  }

  async #fill(enough: () => boolean): Promise<void> {
    while (!enough()) {
      if (this.#closed) throw new Error('git cat-file stopped')
      await new Promise<void>((resolve) => (this.#waiting = resolve))
    }
  }

  async read(sha: string): Promise<Buffer | undefined> {
    this.#child.stdin.write(`${sha}\n`)
    await this.#fill(() => this.#buffer.includes(10))
    const newline = this.#buffer.indexOf(10)
    const [, type = '', size = ''] = this.#buffer.subarray(0, newline).toString('latin1').split(' ')
    const length = Number(size)
    if (type !== 'blob' || !Number.isSafeInteger(length)) {
      this.#buffer = this.#buffer.subarray(newline + 1)
      return undefined
    }
    const end = newline + 1 + length + 1
    await this.#fill(() => this.#buffer.length >= end)
    const content = this.#buffer.subarray(newline + 1, end - 1)
    this.#buffer = this.#buffer.subarray(end)
    return content
  }

  close(): void {
    this.#child.stdin.end()
  }
}

export type CommittedSearch = SearchRequest & { path: string }

export async function searchCommittedFiles(
  repo: string,
  commit: string,
  request: CommittedSearch,
): Promise<SearchResult> {
  const searcher = new Searcher(request)
  const rel = relativePath(request.path)
  const type = rel ? await objectType(repo, revision(commit, rel)) : 'tree'
  if (!type) throw new ProjectError(`"${request.path}" does not exist`)
  const reader = new BlobReader(repo)
  try {
    if (type === 'tree') {
      const tree = await requireDirectory(repo, commit, request.path, rel)
      await walk(tree, rel, {
        readDir: (loc) => entries(repo, loc),
        recursive: true,
        visit: async (entry, name) => {
          if (entry.kind !== 'file' || !searcher.wantsFile(name)) return true
          if ((entry.size ?? 0) > MAX_SEARCH_FILE_BYTES) return true
          return searcher.addFile(name, await reader.read(entry.loc))
        },
      })
    } else if (type === 'blob' && searcher.wantsFile(rel)) {
      const sha = (await git(['--git-dir', repo, 'rev-parse', revision(commit, rel)])).trim()
      searcher.addFile(rel, await reader.read(sha))
    }
  } finally {
    reader.close()
  }
  return searcher.result
}
