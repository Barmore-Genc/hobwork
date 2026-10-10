// Uploads from hob UIs and scripts straight into the hob's files, past the
// size limit of route bodies. Shared by the browser SDK and the host.

// POST starts an upload of `size` bytes to `path`: { path, size, type? } ->
// UploadStatus. GET <id> answers its UploadStatus, PUT <id>?offset=<n> sends
// the next chunk (at most `chunkBytes`, starting at `received`), DELETE <id>
// gives up on it. The answer to the last chunk has the stored file.
export const UPLOADS_PATH = '/_hobwork/uploads'
// PUT <path> with the whole file as the body, for scripts (curl -T).
export const UPLOAD_FILES_PATH = '/_hobwork/files'
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
export const DEFAULT_UPLOAD_BYTES = 100 * 1024 * 1024
// Upload tokens, sent as `Authorization: Bearer <token>`, start with this.
export const UPLOAD_TOKEN_PREFIX = 'hwu_'

export type UploadStatus = {
  id: string
  path: string
  size: number
  received: number
  chunkBytes: number
}

export type UploadedFile = { path: string; size: number; modified: string }

// ctx.payload of a trigger declared as { "upload": "<name>" }: a file that
// arrived through the upload `upload` of hobwork.json. ctx.caller is the person
// who uploaded it from the hob's app, or null for an upload token.
export type UploadEvent = UploadedFile & { upload: string; contentType: string | null }

// Whether `types` from hobwork.json (MIME types like "image/*" or
// "application/pdf", and extensions like ".3mf") let a file with this path
// and Content-Type in. No types lets every file in.
export function uploadTypeAllowed(types: string[] | undefined, path: string, contentType: string | null | undefined): boolean {
  if (!types?.length) return true
  const name = path.toLowerCase()
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  return types.some((allowed) => {
    const pattern = allowed.toLowerCase()
    if (pattern.startsWith('.')) return name.endsWith(pattern)
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1))
    return type === pattern
  })
}
