import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, open, rm, truncate } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { filePathProblem } from '../../../packages/sdk/src/runner/protocol.ts'
import {
  UPLOAD_CHUNK_BYTES,
  UPLOAD_FILES_PATH,
  UPLOAD_TOKEN_PREFIX,
  uploadTypeAllowed,
  type UploadedFile,
  type UploadStatus,
} from '../../../packages/sdk/src/uploads.ts'
import { publishChange } from '../changes.ts'
import type { Host } from '../host.ts'
import { HttpError } from '../http.ts'
import { requireProject } from '../projects.ts'
import type { UploadEntry } from './config.ts'
import { FilesFailure, place, projectFilesDir, UPLOADS_DIR } from './files.ts'

// Chunked uploads nobody continued for this long are thrown away.
export const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isUploadToken(value: string): boolean {
  return value.startsWith(UPLOAD_TOKEN_PREFIX)
}

// Only the hash is stored, so the token is shown once; rotating replaces the
// old token right away. Tokens are for the deployed version only: scripts
// have no business uploading to a branch preview.
export function rotateUploadToken(host: Host, project: string, name: string): string {
  const { id } = requireProject(host, project)
  const token = `${UPLOAD_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  host.db
    .prepare(
      `INSERT INTO upload_tokens (project_id, name, token_hash) VALUES (?, ?, ?)
       ON CONFLICT (project_id, name) DO UPDATE SET token_hash = excluded.token_hash,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(id, name, hashToken(token))
  publishChange(host.db, { kind: 'project', project })
  return token
}

// The upload a token belongs to, for this hob.
export function uploadOfToken(host: Host, projectId: number, token: string): string | undefined {
  const row = host.db.prepare('SELECT name FROM upload_tokens WHERE project_id = ? AND token_hash = ?').get(projectId, hashToken(token))
  return row ? String(row.name) : undefined
}

// Where a script PUTs files of an upload: this followed by the rest of the path.
export function uploadFilesUrl(appOrigin: string, prefix: string): string {
  return `${appOrigin}${UPLOAD_FILES_PATH}/${prefix}`
}

export function uploadTokenCreatedAt(host: Host, project: string, name: string): string | undefined {
  const row = host.db
    .prepare('SELECT u.created_at FROM upload_tokens u JOIN projects p ON p.id = u.project_id WHERE p.name = ? AND u.name = ?')
    .get(project, name)
  return row ? String(row.created_at) : undefined
}

// Who sends the file: a person from the hob's app, or a script with a token,
// which names the one upload it may use.
export type Uploader = { userId: number } | { token: string }

export type UploadTarget = {
  project: string
  projectId: number
  branch?: string
  uploads: Record<string, UploadEntry>
  uploader: Uploader
}

export type Completed = { name: string; file: UploadedFile; contentType: string | null }

type Row = {
  id: string
  name: string
  path: string
  size: number
  received: number
  content_type: string | null
  user_id: number | null
  branch: string | null
}

// The upload whose prefix `path` is under, longest prefix first. A token
// only reaches its own upload.
function entryFor(target: UploadTarget, path: string): { name: string; entry: UploadEntry } {
  const problem = filePathProblem(path)
  if (problem) throw new HttpError(400, problem)
  const found = Object.entries(target.uploads)
    .filter(([, entry]) => path.startsWith(entry.prefix))
    .sort((a, b) => b[1].prefix.length - a[1].prefix.length)[0]
  if (found && 'token' in target.uploader && target.uploader.token !== found[0]) {
    throw new HttpError(403, `This upload token is for the upload "${target.uploader.token}", and "${path}" belongs to "${found[0]}"`)
  }
  if (!found) {
    const prefixes = Object.values(target.uploads).map((entry) => `"${entry.prefix}"`)
    const where = prefixes.length ? `Files can be uploaded under ${prefixes.join(', ')}` : 'This hob takes no uploads'
    throw new HttpError(403, `"${path}" is not in an upload folder of this hob. ${where}`)
  }
  return { name: found[0], entry: found[1] }
}

function checkFile(entry: UploadEntry, path: string, size: number, contentType: string | null) {
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'size must be the file size in bytes')
  if (size > entry.maxBytes) throw new HttpError(413, `This upload takes files of at most ${megabytes(entry.maxBytes)}`)
  if (!uploadTypeAllowed(entry.types, path, contentType)) {
    throw new HttpError(415, `This upload takes only ${entry.types.join(', ')} files`)
  }
}

function megabytes(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MB`
}

function contentTypeOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null
}

function tempPath(host: Host, project: string, id: string): string {
  return join(dirname(projectFilesDir(host, project)), UPLOADS_DIR, `upload-${id}`)
}

// Copies at most `max` bytes of `req` into `out`, which fails past that.
function limited(max: number, tooLarge: string): Transform & { size(): number } {
  let size = 0
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      callback(size > max ? new HttpError(413, tooLarge) : null, chunk)
    },
  })
  return Object.assign(transform, { size: () => size })
}

async function store(host: Host, target: UploadTarget, temp: string, path: string): Promise<UploadedFile> {
  const files = projectFilesDir(host, target.project)
  try {
    await place(files, temp, path)
  } catch (err) {
    await rm(temp, { force: true })
    if (err instanceof FilesFailure) throw new HttpError(err.status, err.message)
    throw err
  }
  const stats = await lstat(join(files, ...path.split('/')))
  return { path, size: stats.size, modified: stats.mtime.toISOString() }
}

export function createUploads(host: Host) {
  // One chunk at a time per upload: a second request for the same upload
  // would write at the same offset.
  const busy = new Set<string>()

  function row(target: UploadTarget, id: string): Row {
    const found = host.db
      .prepare('SELECT id, name, path, size, received, content_type, user_id, branch FROM chunked_uploads WHERE id = ? AND project_id = ?')
      .get(id, target.projectId) as Row | undefined
    const mine =
      found &&
      (found.branch ?? undefined) === target.branch &&
      ('userId' in target.uploader ? found.user_id === target.uploader.userId : found.user_id === null && found.name === target.uploader.token)
    if (!mine) throw new HttpError(404, 'There is no such upload. It may have expired: start it again')
    return found
  }

  function statusOf(found: Pick<Row, 'id' | 'path' | 'size' | 'received'>): UploadStatus {
    return { id: found.id, path: found.path, size: found.size, received: found.received, chunkBytes: UPLOAD_CHUNK_BYTES }
  }

  return {
    async start(target: UploadTarget, body: unknown): Promise<UploadStatus> {
      const { path, size, type } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
      if (typeof path !== 'string') throw new HttpError(400, 'path must be the file path to store the upload at')
      const { name, entry } = entryFor(target, path)
      const contentType = contentTypeOf(type)
      checkFile(entry, path, size as number, contentType)
      const id = randomBytes(16).toString('base64url')
      const temp = tempPath(host, target.project, id)
      await mkdir(dirname(temp), { recursive: true })
      await rm(temp, { force: true })
      await (await open(temp, 'wx', 0o600)).close()
      host.db
        .prepare(
          `INSERT INTO chunked_uploads (id, project_id, branch, name, path, size, content_type, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, target.projectId, target.branch ?? null, name, path, size as number, contentType, 'userId' in target.uploader ? target.uploader.userId : null)
      return statusOf({ id, path, size: size as number, received: 0 })
    },

    status(target: UploadTarget, id: string): UploadStatus {
      return statusOf(row(target, id))
    },

    // Appends one chunk at `offset`, which must be what has arrived so far.
    // Returns the stored file once the last byte is in.
    async chunk(target: UploadTarget, id: string, offset: number, req: IncomingMessage): Promise<UploadStatus | Completed> {
      const found = row(target, id)
      if (busy.has(id)) throw new HttpError(409, 'Another part of this upload is being sent. Send the parts one after another')
      if (offset !== found.received) {
        throw new HttpError(409, `This upload has ${found.received} bytes, so the next part starts at offset ${found.received}`)
      }
      busy.add(id)
      const temp = tempPath(host, target.project, id)
      try {
        const remaining = found.size - found.received
        const max = Math.min(UPLOAD_CHUNK_BYTES, remaining)
        if (Number(req.headers['content-length'] ?? 0) > max) throw new HttpError(413, `A part is at most ${max} bytes here`)
        const limit = limited(max, `A part is at most ${max} bytes here`)
        // A part that failed half way left bytes after `received`; they are written over.
        await pipeline(req, limit, createWriteStream(temp, { flags: 'r+', start: offset }))
        const received = offset + limit.size()
        if (received < found.size) {
          host.db
            .prepare("UPDATE chunked_uploads SET received = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
            .run(received, id)
          return statusOf({ ...found, received })
        }
        // The file can be shorter on disk than an earlier, failed write left it.
        await truncate(temp, found.size)
        host.db.prepare('DELETE FROM chunked_uploads WHERE id = ?').run(id)
        const file = await store(host, target, temp, found.path)
        return { name: found.name, file, contentType: found.content_type }
      } finally {
        busy.delete(id)
      }
    },

    async cancel(target: UploadTarget, id: string): Promise<void> {
      row(target, id)
      host.db.prepare('DELETE FROM chunked_uploads WHERE id = ?').run(id)
      await rm(tempPath(host, target.project, id), { force: true })
    },

    // The whole file in one request body, for scripts.
    async single(target: UploadTarget, path: string, req: IncomingMessage): Promise<Completed> {
      const { name, entry } = entryFor(target, path)
      const contentType = contentTypeOf(req.headers['content-type'])
      const declared = req.headers['content-length']
      checkFile(entry, path, Number(declared ?? 0), contentType)
      const temp = tempPath(host, target.project, randomBytes(16).toString('base64url'))
      await mkdir(dirname(temp), { recursive: true })
      try {
        await pipeline(req, limited(entry.maxBytes, `This upload takes files of at most ${megabytes(entry.maxBytes)}`), createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
      } catch (err) {
        await rm(temp, { force: true })
        throw err
      }
      return { name, file: await store(host, target, temp, path), contentType }
    },
  }
}

export type Uploads = ReturnType<typeof createUploads>

// Drops chunked uploads nobody continued, and their bytes.
export async function expireUploads(host: Host, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - UPLOAD_EXPIRY_MS).toISOString()
  const stale = host.db
    .prepare('SELECT u.id, p.name AS project FROM chunked_uploads u JOIN projects p ON p.id = u.project_id WHERE u.updated_at < ?')
    .all(cutoff) as { id: string; project: string }[]
  for (const { id, project } of stale) {
    host.db.prepare('DELETE FROM chunked_uploads WHERE id = ?').run(id)
    await rm(tempPath(host, project, id), { force: true })
  }
  return stale.length
}
