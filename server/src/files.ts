import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ProjectError } from './projects.ts'
import { SKIPPED_DIRS, type SearchRequest, type SearchResult } from './search-worker.ts'

// File operations on a workspace checkout. Workspace VMs write to the same
// directory, so every path is checked against symlinks that lead out of it.

const MAX_LIST_ENTRIES = 2000
const SEARCH_TIMEOUT_MS = 10_000

type CheckoutPath = { abs: string; rel: string }

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code
}

export function checkoutPath(root: string, path: string): CheckoutPath {
  if (path.includes('\0')) throw new ProjectError('Path must not contain NUL characters')
  if (isAbsolute(path)) {
    throw new ProjectError(`Path "${path}" must be relative to the hob root, e.g. "src/index.ts"`)
  }
  const abs = resolve(root, path)
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ProjectError(`Path "${path}" is outside the hob`)
  }
  if (rel.split(sep).some((part) => part === '.git')) {
    throw new ProjectError(`Path "${path}" is inside a .git directory`)
  }
  return { abs, rel: rel.split(sep).join('/') }
}

async function assertInside(root: string, abs: string, path: string): Promise<string> {
  const [realRoot, real] = await Promise.all([realpath(root), realpath(abs)])
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ProjectError(`Path "${path}" resolves outside the hob through a symlink`)
  }
  return real
}

async function existingAncestor(abs: string): Promise<string> {
  for (let dir = abs; ; dir = dirname(dir)) {
    try {
      await lstat(dir)
      return dir
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err
    }
  }
}

async function resolveExisting(root: string, path: string): Promise<CheckoutPath & { real: string }> {
  const target = checkoutPath(root, path)
  try {
    return { ...target, real: await assertInside(root, target.abs, path) }
  } catch (err) {
    if (isErrno(err, 'ENOENT')) throw new ProjectError(`"${path}" does not exist`)
    throw err
  }
}

// O_NOFOLLOW keeps a symlink swapped in after the check from being followed.
async function readNoFollow(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

export const MAX_CONFIG_FILE_BYTES = 1024 * 1024

// For files the host parses out of a checkout (hobwork.json, package.json).
// O_NONBLOCK keeps a FIFO from blocking the open, and the size cap keeps the
// guest from making the host read an unbounded file.
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

// Returns the directory relative to the checkout root, '.' for the root.
export async function checkoutDirectory(root: string, path: string): Promise<string> {
  const { rel, real } = await resolveExisting(root, path)
  if (!(await lstat(real)).isDirectory()) throw new ProjectError(`"${path}" is not a directory`)
  return rel || '.'
}

export async function readCheckoutFile(root: string, path: string): Promise<Buffer> {
  const { real } = await resolveExisting(root, path)
  if ((await lstat(real)).isDirectory()) {
    throw new ProjectError(`"${path}" is a directory. Use list_files to see its contents`)
  }
  return readNoFollow(real)
}

export async function writeCheckoutFile(
  root: string,
  path: string,
  content: string,
): Promise<{ created: boolean }> {
  const { abs, rel } = checkoutPath(root, path)
  if (!rel) throw new ProjectError('Path must name a file')
  const ancestor = await existingAncestor(abs)
  let target = abs
  if (ancestor === abs) {
    target = await assertInside(root, abs, path)
    if ((await lstat(target)).isDirectory()) throw new ProjectError(`"${path}" is a directory`)
  } else {
    await assertInside(root, ancestor, path)
    await mkdir(dirname(abs), { recursive: true })
  }
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  )
  try {
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
  return { created: ancestor !== abs }
}

export async function editCheckoutFile(
  root: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<{ replacements: number }> {
  if (!oldString) throw new ProjectError('old_string must not be empty. Use write_file to create a file')
  if (oldString === newString) throw new ProjectError('old_string and new_string are identical')
  const content = (await readCheckoutFile(root, path)).toString('utf8')
  const count = content.split(oldString).length - 1
  if (count === 0) {
    throw new ProjectError(
      `old_string was not found in "${path}". It must match the file exactly, including whitespace and indentation`,
    )
  }
  if (count > 1 && !replaceAll) {
    throw new ProjectError(
      `old_string occurs ${count} times in "${path}". Include more surrounding lines to make it unique, or set replace_all`,
    )
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, () => newString)
  await writeCheckoutFile(root, path, updated)
  return { replacements: replaceAll ? count : 1 }
}

export async function deleteCheckoutFile(root: string, path: string): Promise<void> {
  const { abs, rel } = checkoutPath(root, path)
  if (!rel) throw new ProjectError('Path must name a file')
  let stat
  try {
    stat = await lstat(abs)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) throw new ProjectError(`"${path}" does not exist`)
    throw err
  }
  if (stat.isDirectory()) {
    throw new ProjectError(`"${path}" is a directory. Delete the files in it instead`)
  }
  // The link itself is removed, never its target, so only the parent must be inside.
  await assertInside(root, dirname(abs), path)
  await unlink(abs)
}

export type FileList = { entries: string[]; truncated: boolean }

// Recursive listings return files only. Non-recursive listings also return
// directories, with a trailing slash.
export async function listCheckoutFiles(root: string, path: string, recursive: boolean): Promise<FileList> {
  const { rel, real } = await resolveExisting(root, path)
  if (!(await lstat(real)).isDirectory()) throw new ProjectError(`"${path}" is not a directory`)
  const entries: string[] = []
  let truncated = false

  async function walk(dir: string, prefix: string): Promise<void> {
    const children = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const child of children) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true
        return
      }
      const name = prefix ? `${prefix}/${child.name}` : child.name
      if (child.isDirectory()) {
        if (!recursive) entries.push(`${name}/`)
        else if (!SKIPPED_DIRS.has(child.name)) await walk(join(dir, child.name), name)
      } else {
        entries.push(name)
      }
    }
  }

  await walk(real, rel)
  return { entries, truncated }
}

export async function searchCheckout(
  root: string,
  request: Omit<SearchRequest, 'dir' | 'prefix'> & { path: string },
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<SearchResult> {
  const { path, ...options } = request
  try {
    new RegExp(options.pattern, options.ignoreCase ? 'i' : '')
  } catch (err) {
    throw new ProjectError(`Invalid regular expression: ${(err as Error).message}`)
  }
  const { rel, real } = await resolveExisting(root, path)
  const workerData: SearchRequest = { ...options, dir: real, prefix: rel }

  // Patterns come from agents. Matching in a worker with a deadline keeps a
  // catastrophically backtracking pattern from blocking the host.
  const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { workerData })
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(
        new ProjectError(
          `Search timed out after ${timeoutMs / 1000}s. Narrow the path or glob, or simplify the pattern`,
        ),
      )
    }, timeoutMs)
    worker.once('message', (result: SearchResult) => {
      clearTimeout(timer)
      resolvePromise(result)
    })
    worker.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
