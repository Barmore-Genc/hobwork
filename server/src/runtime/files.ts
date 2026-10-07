import { randomUUID } from 'node:crypto'
import { constants, createWriteStream, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
  FILE_MODIFIED_HEADER,
  FILE_SIZE_HEADER,
  FILES_PATH,
  filePathProblem,
  MAX_FILE_BYTES,
  MAX_FILE_LIST,
  type FileInfo,
  type FilesErrorCode,
  type FilesRequest,
} from '../../../packages/sdk/src/runner/protocol.ts'
import type { Host } from '../host.ts'
import { sendFile } from '../static.ts'

// A hob's files (ctx.files) live next to its DB, so deleting, restoring and
// renaming the hob take them along. Uploads are written to UPLOADS_DIR and
// renamed into place, so a file is never seen half written and a reader keeps
// the old contents when a new version replaces it.
export const FILES_DIR = 'files'
export const UPLOADS_DIR = 'files.tmp'
const MAX_REQUEST_BYTES = 64 * 1024

export function projectFilesDir(host: Host, project: string): string {
  return join(host.dataDir, 'projects', project, FILES_DIR)
}

function uploadsDir(files: string): string {
  return join(dirname(files), UPLOADS_DIR)
}

// Uploads stream from the VM. The handler bounds what it reads. Gets the request head only.
export function streamsFileBody(request: Request): boolean {
  return request.method === 'PUT' && new URL(request.url).pathname.startsWith(`${FILES_PATH}/`)
}

class FilesFailure extends Error {
  status: number
  code: FilesErrorCode

  constructor(status: number, code: FilesErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const tooLarge = (max: number) => new FilesFailure(413, 'too_large', `A file is at most ${max / 1024 / 1024}MB`)

function failure(err: FilesFailure): Response {
  return Response.json({ ok: false, error: { code: err.code, message: err.message } }, { status: err.status })
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

function infoOf(path: string, stats: Stats): FileInfo {
  return { path, size: stats.size, modified: stats.mtime.toISOString() }
}

// The file path in a URL path below a prefix, with each segment decoded, or
// undefined when it is not a valid file path.
export function decodeFilePath(encoded: string): string | undefined {
  let path: string
  try {
    path = encoded.split('/').map(decodeURIComponent).join('/')
  } catch {
    return undefined
  }
  return filePathProblem(path) ? undefined : path
}

function locate(files: string, path: string): string {
  return join(files, ...path.split('/'))
}

async function regularFile(path: string): Promise<Stats | undefined> {
  const stats = await lstat(path).catch(() => undefined)
  return stats?.isFile() ? stats : undefined
}

async function put(files: string, path: string, request: Request, max: number): Promise<Response> {
  if (Number(request.headers.get('content-length')) > max) {
    await request.body?.cancel()
    throw tooLarge(max)
  }
  const uploads = uploadsDir(files)
  await mkdir(uploads, { recursive: true })
  const temp = join(uploads, randomUUID())
  let size = 0
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      callback(size > max ? tooLarge(max) : null, chunk)
    },
  })
  const body = request.body ? Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>) : Readable.from([])
  try {
    await pipeline(body, limit, createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
    await place(files, temp, path)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
  const stats = await regularFile(locate(files, path))
  if (!stats) throw new FilesFailure(409, 'conflict', `"${path}" changed while it was stored`)
  return Response.json({ ok: true, result: infoOf(path, stats) })
}

async function place(files: string, temp: string, path: string): Promise<void> {
  const target = locate(files, path)
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(dirname(target), { recursive: true })
    } catch (err) {
      if (errnoOf(err) === 'ENOTDIR' || errnoOf(err) === 'EEXIST') {
        throw new FilesFailure(409, 'conflict', `A parent of "${path}" is a file`)
      }
      throw err
    }
    try {
      await rename(temp, target)
      return
    } catch (err) {
      // A delete removed the directory, now empty, between mkdir and rename.
      if (errnoOf(err) === 'ENOENT' && attempt < 3) continue
      if (['EISDIR', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EPERM'].includes(errnoOf(err) ?? '')) {
        throw new FilesFailure(409, 'conflict', `"${path}" is a directory`)
      }
      throw err
    }
  }
}

// Opens a regular file, so what is sent is what was measured even if the
// file is replaced meanwhile.
async function openFile(target: string): Promise<{ handle: FileHandle; stats: Stats } | undefined> {
  let handle: FileHandle
  try {
    // O_NOFOLLOW: the host only ever writes regular files here, so a link is not ours.
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  const stats = await handle.stat().catch(() => undefined)
  if (stats?.isFile()) return { handle, stats }
  await handle.close()
  return undefined
}

async function get(files: string, path: string): Promise<Response> {
  const opened = await openFile(locate(files, path))
  if (!opened) throw new FilesFailure(404, 'not_found', `There is no file "${path}"`)
  const { handle, stats } = opened
  const stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>
  return new Response(stream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(stats.size),
      [FILE_SIZE_HEADER]: String(stats.size),
      [FILE_MODIFIED_HEADER]: stats.mtime.toISOString(),
    },
  })
}

async function remove(files: string, path: string): Promise<boolean> {
  const target = locate(files, path)
  if (!(await regularFile(target))) return false
  try {
    await unlink(target)
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return false
    throw err
  }
  // Empty directories go too, so a deleted "a/b" leaves room for a file "a".
  for (let dir = dirname(target); dir !== files && dir.startsWith(files); dir = dirname(dir)) {
    try {
      await rmdir(dir)
    } catch {
      break
    }
  }
  return true
}

const LIST_TEXT = /^[A-Za-z0-9._/-]*$/

async function list(files: string, request: Extract<FilesRequest, { action: 'list' }>): Promise<FileInfo[]> {
  const { prefix = '', after = '', limit = MAX_FILE_LIST } = request
  for (const [name, value] of [['prefix', prefix], ['after', after]] as const) {
    if (typeof value !== 'string' || value.length > 512 || !LIST_TEXT.test(value)) {
      throw new FilesFailure(400, 'invalid_path', `${name} must be part of a file path`)
    }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FILE_LIST) {
    throw new FilesFailure(400, 'invalid_path', `limit must be a whole number from 1 to ${MAX_FILE_LIST}`)
  }
  // Only the directory the prefix names has to be walked.
  const base = prefix.slice(0, prefix.lastIndexOf('/') + 1).replace(/\/$/, '')
  if (base && filePathProblem(base)) return []
  const found: { path: string; stats: Stats }[] = []
  async function walk(dir: string, relative: string) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(dir, entry.name), path)
      else if (entry.isFile() && path.startsWith(prefix) && path > after) {
        const stats = await regularFile(join(dir, entry.name))
        if (stats) found.push({ path, stats })
      }
    }
  }
  await walk(base ? locate(files, base) : files, base)
  // Directory order puts "a/b" before "a.txt"; callers page through path order.
  found.sort((a, b) => (a.path < b.path ? -1 : 1))
  return found.slice(0, limit).map(({ path, stats }) => infoOf(path, stats))
}

async function readJson(request: Request): Promise<FilesRequest> {
  const text = await request.text()
  if (text.length > MAX_REQUEST_BYTES) throw new FilesFailure(413, 'too_large', 'Request body too large')
  try {
    return JSON.parse(text) as FilesRequest
  } catch {
    throw new FilesFailure(400, 'invalid_path', 'Body must be JSON')
  }
}

function checkPath(path: unknown): asserts path is string {
  const problem = filePathProblem(path)
  if (problem) throw new FilesFailure(400, 'invalid_path', problem)
}

// Answers ctx.files calls under /v1/files from a hob's VMs. `files` is the
// hob's files directory, shared by the deployed version and its previews.
export async function filesResponse(request: Request, files: string, maxFileBytes = MAX_FILE_BYTES): Promise<Response> {
  const { pathname } = new URL(request.url)
  try {
    if (pathname === FILES_PATH) {
      if (request.method !== 'POST') throw new FilesFailure(405, 'invalid_path', `${request.method} ${pathname} does not exist`)
      const body = await readJson(request)
      let result: unknown
      if (body.action === 'stat') {
        checkPath(body.path)
        const stats = await regularFile(locate(files, body.path))
        result = stats ? infoOf(body.path, stats) : null
      } else if (body.action === 'delete') {
        checkPath(body.path)
        result = await remove(files, body.path)
      } else if (body.action === 'list') {
        result = await list(files, body)
      } else {
        throw new FilesFailure(400, 'invalid_path', 'Unknown action')
      }
      return Response.json({ ok: true, result })
    }
    const encoded = pathname.slice(FILES_PATH.length + 1)
    const path = decodeFilePath(encoded)
    if (path === undefined) {
      await request.body?.cancel()
      throw new FilesFailure(400, 'invalid_path', `"${encoded}" is not a valid file path`)
    }
    if (request.method === 'PUT') return await put(files, path, request, maxFileBytes)
    if (request.method === 'GET') return await get(files, path)
    throw new FilesFailure(405, 'invalid_path', `${request.method} ${FILES_PATH}/<path> does not exist`)
  } catch (err) {
    if (err instanceof FilesFailure) return failure(err)
    throw err
  }
}

export type StaticMount = { prefix: string; dir: string; public: boolean }

// The mount that serves a URL path, if any. Mounts come longest prefix first.
export function findStaticMount(mounts: StaticMount[], pathname: string): StaticMount | undefined {
  return mounts.find((mount) => pathname === mount.prefix || pathname.startsWith(`${mount.prefix}/`))
}

// What browsers may show of a hob's files. These come from users and handlers,
// not from the build, so nothing that runs script on the app origin (HTML,
// JavaScript, CSS, XML) gets its own type: those go out as downloads.
const STATIC_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.ogv': 'video/ogg',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

// An SVG opened on its own is a document that can run script, so it gets an
// opaque origin. Other types cannot, and a sandbox would block the browser's
// PDF viewer.
const SVG_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"

function staticHeaders(path: string): Record<string, string> {
  const ext = extname(path).toLowerCase()
  const type = STATIC_TYPES[ext]
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'content-type': type ?? 'application/octet-stream',
    ...(type ? {} : { 'content-disposition': 'attachment' }),
    ...(ext === '.svg' ? { 'content-security-policy': SVG_POLICY } : {}),
  }
}

function sendStaticText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(`${text}\n`)
}

// Serves a file of the hob from a `static` mount without starting its VM.
// `pathname` is the still encoded URL path.
export async function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  options: { files: string; mount: StaticMount; pathname: string },
): Promise<void> {
  const { files, mount, pathname } = options
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendStaticText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' })
  const rest = pathname.slice(mount.prefix.length + 1)
  const path = rest ? decodeFilePath(`${mount.dir}/${rest}`) : undefined
  const opened = path === undefined ? undefined : await openFile(locate(files, path))
  if (!opened) return sendStaticText(res, 404, 'Not found')
  // Files can be replaced under the same name, so browsers check the ETag.
  const target = locate(files, path!)
  sendFile(req, res, target, opened.stats, `${mount.public ? 'public' : 'private'}, no-cache`, staticHeaders(target), opened.handle)
}
