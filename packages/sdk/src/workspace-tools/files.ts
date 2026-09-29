import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ToolError } from './error.ts'
import { MAX_SEARCH_FILE_BYTES, Searcher, type SearchRequest } from './search.ts'
import { walk, type DirEntry } from './walk.ts'

// File operations on the workspace, run inside the VM. Every path is checked
// against symlinks that lead out of the workspace root (the current directory).

export const MAX_READ_BYTES = 4 * 1024 * 1024
export const MAX_WRITE_BYTES = 16 * 1024 * 1024
const MAX_LIST_ENTRIES = 2000
export const MAX_MIGRATION_BYTES = 1024 * 1024
export const MAX_MIGRATIONS_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_MIGRATION_FILES = 1000
const MIGRATION_NAME = /^\d+_[A-Za-z0-9_.-]+\.sql$/

export type FileRequest =
  | { op: 'read'; path: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'edit'; path: string; oldString: string; newString: string; replaceAll: boolean }
  | { op: 'delete'; path: string }
  | { op: 'list'; path: string; recursive: boolean }
  | ({ op: 'search'; path: string } & SearchRequest)
  | { op: 'migrations' }

export type FileResponse =
  | { op: 'read'; binary: false; content: string; size: number }
  | { op: 'read'; binary: true; size: number }
  | { op: 'write'; created: boolean }
  | { op: 'edit'; replacements: number }
  | { op: 'delete' }
  | { op: 'list'; entries: string[]; truncated: boolean }
  | { op: 'search'; matches: string[]; truncated: boolean; filesSearched: number }
  | { op: 'migrations'; files: { name: string; sql: string }[] }

type Target = { abs: string; rel: string }

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code
}

export function targetPath(root: string, path: string): Target {
  if (path.includes('\0')) throw new ToolError('Path must not contain NUL characters')
  if (isAbsolute(path)) {
    throw new ToolError(`Path "${path}" must be relative to the hob root, e.g. "src/index.ts"`)
  }
  const abs = resolve(root, path)
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(`Path "${path}" is outside the hob`)
  }
  if (rel.split(sep).some((part) => part === '.git')) {
    throw new ToolError(`Path "${path}" is inside a .git directory`)
  }
  return { abs, rel: rel.split(sep).join('/') }
}

async function assertInside(root: string, abs: string, path: string): Promise<string> {
  const [realRoot, real] = await Promise.all([realpath(root), realpath(abs)])
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ToolError(`Path "${path}" resolves outside the hob through a symlink`)
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

async function resolveExisting(root: string, path: string): Promise<Target & { real: string }> {
  const target = targetPath(root, path)
  try {
    return { ...target, real: await assertInside(root, target.abs, path) }
  } catch (err) {
    if (isErrno(err, 'ENOENT')) throw new ToolError(`"${path}" does not exist`)
    throw err
  }
}

// O_NOFOLLOW keeps a symlink swapped in after the check from being followed.
// O_NONBLOCK keeps a FIFO from blocking the open.
async function readRegular(real: string, path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (stat.isDirectory()) {
      throw new ToolError(`"${path}" is a directory. Use list_files to see its contents`)
    }
    if (!stat.isFile()) throw new ToolError(`"${path}" is not a regular file`)
    if (stat.size > maxBytes) {
      throw new ToolError(
        `"${path}" is ${stat.size} bytes, over the ${maxBytes} byte limit of the file tools. Use bash to read part of it, for example with sed -n`,
      )
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function read(root: string, path: string): Promise<FileResponse> {
  const { real } = await resolveExisting(root, path)
  const content = await readRegular(real, path, MAX_READ_BYTES)
  if (content.subarray(0, 8000).includes(0)) return { op: 'read', binary: true, size: content.length }
  return { op: 'read', binary: false, content: content.toString('utf8'), size: content.length }
}

async function writeFile(root: string, path: string, content: string): Promise<{ created: boolean }> {
  const { abs, rel } = targetPath(root, path)
  if (!rel) throw new ToolError('Path must name a file')
  const ancestor = await existingAncestor(abs)
  let target = abs
  if (ancestor === abs) {
    target = await assertInside(root, abs, path)
    if ((await lstat(target)).isDirectory()) throw new ToolError(`"${path}" is a directory`)
  } else {
    await assertInside(root, ancestor, path)
    await mkdir(dirname(abs), { recursive: true })
  }
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o644,
  )
  try {
    if (!(await handle.stat()).isFile()) throw new ToolError(`"${path}" is not a regular file`)
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
  return { created: ancestor !== abs }
}

async function edit(
  root: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<{ replacements: number }> {
  if (!oldString) throw new ToolError('old_string must not be empty. Use write_file to create a file')
  if (oldString === newString) throw new ToolError('old_string and new_string are identical')
  const { real } = await resolveExisting(root, path)
  const content = (await readRegular(real, path, MAX_READ_BYTES)).toString('utf8')
  const count = content.split(oldString).length - 1
  if (count === 0) {
    throw new ToolError(
      `old_string was not found in "${path}". It must match the file exactly, including whitespace and indentation`,
    )
  }
  if (count > 1 && !replaceAll) {
    throw new ToolError(
      `old_string occurs ${count} times in "${path}". Include more surrounding lines to make it unique, or set replace_all`,
    )
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, () => newString)
  await writeFile(root, path, updated)
  return { replacements: replaceAll ? count : 1 }
}

async function remove(root: string, path: string): Promise<void> {
  const { abs, rel } = targetPath(root, path)
  if (!rel) throw new ToolError('Path must name a file')
  let stat
  try {
    stat = await lstat(abs)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) throw new ToolError(`"${path}" does not exist`)
    throw err
  }
  if (stat.isDirectory()) {
    throw new ToolError(`"${path}" is a directory. Delete the files in it instead`)
  }
  // The link itself is removed, never its target, so only the parent must be inside.
  await assertInside(root, dirname(abs), path)
  await unlink(abs)
}

async function readDir(dir: string): Promise<DirEntry<string>[]> {
  return (await readdir(dir, { withFileTypes: true })).map((child) => ({
    name: child.name,
    kind: child.isDirectory() ? 'dir' : child.isFile() ? 'file' : 'other',
    loc: join(dir, child.name),
  }))
}

// Recursive listings return files only. Non-recursive listings also return
// directories, with a trailing slash.
async function list(root: string, path: string, recursive: boolean): Promise<FileResponse> {
  const { rel, real } = await resolveExisting(root, path)
  if (!(await lstat(real)).isDirectory()) throw new ToolError(`"${path}" is not a directory`)
  const entries: string[] = []
  let truncated = false
  await walk(real, rel, {
    readDir,
    recursive,
    visit: (entry, name) => {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true
        return false
      }
      entries.push(entry.kind === 'dir' ? `${name}/` : name)
      return true
    },
  })
  return { op: 'list', entries, truncated }
}

// Regular files only: neither the directory nor the files are followed through
// symlinks, so the host can trust that the content came from the checkout.
async function readMigrations(root: string): Promise<FileResponse> {
  const dir = join(root, 'migrations')
  let stat
  try {
    stat = await lstat(dir)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { op: 'migrations', files: [] }
    throw err
  }
  if (!stat.isDirectory()) throw new ToolError('migrations must be a directory')
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()
  if (names.length > MAX_MIGRATION_FILES) throw new ToolError(`migrations has more than ${MAX_MIGRATION_FILES} files`)
  const files: { name: string; sql: string }[] = []
  let total = 0
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) throw new ToolError(`migrations/${name} must be named like 0001_add_spools.sql`)
    let handle
    try {
      handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (err) {
      if (isErrno(err, 'ELOOP')) throw new ToolError(`migrations/${name} must be a regular file`)
      throw err
    }
    try {
      const file = await handle.stat()
      if (!file.isFile()) throw new ToolError(`migrations/${name} must be a regular file`)
      if (file.size > MAX_MIGRATION_BYTES) {
        throw new ToolError(`migrations/${name} is over the ${MAX_MIGRATION_BYTES} byte limit for a migration`)
      }
      total += file.size
      if (total > MAX_MIGRATIONS_TOTAL_BYTES) throw new ToolError(`migrations are over ${MAX_MIGRATIONS_TOTAL_BYTES} bytes in total`)
      files.push({ name, sql: (await handle.readFile()).toString('utf8') })
    } finally {
      await handle.close()
    }
  }
  return { op: 'migrations', files }
}

async function readSmallFile(path: string): Promise<Buffer | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) return undefined
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

async function search(root: string, request: SearchRequest & { path: string }): Promise<FileResponse> {
  let searcher
  try {
    searcher = new Searcher(request)
  } catch (err) {
    throw new ToolError(`Invalid regular expression: ${(err as Error).message}`)
  }
  const { rel, real } = await resolveExisting(root, request.path)
  if ((await lstat(real)).isDirectory()) {
    // Symlinks are never followed; their targets may be outside the workspace.
    await walk(real, rel, {
      readDir,
      recursive: true,
      visit: async (entry, name) => {
        if (entry.kind !== 'file' || !searcher.wantsFile(name)) return true
        return searcher.addFile(name, await readSmallFile(entry.loc))
      },
    })
  } else if (searcher.wantsFile(rel)) {
    searcher.addFile(rel, await readSmallFile(real))
  }
  return { op: 'search', ...searcher.result }
}

export async function runFileRequest(root: string, request: FileRequest): Promise<FileResponse> {
  switch (request.op) {
    case 'read':
      return read(root, request.path)
    case 'write':
      if (Buffer.byteLength(request.content) > MAX_WRITE_BYTES) {
        throw new ToolError(`Content is over the ${MAX_WRITE_BYTES} byte limit of the file tools`)
      }
      return { op: 'write', ...(await writeFile(root, request.path, request.content)) }
    case 'edit':
      return {
        op: 'edit',
        ...(await edit(root, request.path, request.oldString, request.newString, request.replaceAll)),
      }
    case 'delete':
      await remove(root, request.path)
      return { op: 'delete' }
    case 'list':
      return list(root, request.path, request.recursive)
    case 'search':
      return search(root, request)
    case 'migrations':
      return readMigrations(root)
  }
}
