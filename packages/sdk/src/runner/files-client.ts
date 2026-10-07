import type { FileBody, Files, ListFilesOptions, StoredFile } from '../index.ts'
import {
  FILE_MODIFIED_HEADER,
  FILE_SIZE_HEADER,
  FILES_PATH,
  filePathProblem,
  fileUrlPath,
  type FileInfo,
  type FilesErrorCode,
  type FilesRequest,
  type FilesResponse,
} from './protocol.ts'

// The runner and the handler bundle each have their own copy of this class, so
// instanceof checks a brand instead of the prototype chain.
const BRAND = Symbol.for('hobwork.FilesError')

export class FilesError extends Error {
  // "invalid_path", "not_found", "too_large", "conflict" (a file is in the way
  // of a directory or the other way round) or "unavailable".
  code: FilesErrorCode

  constructor(code: FilesErrorCode, message: string) {
    super(message)
    this.name = 'FilesError'
    this.code = code
    Object.defineProperty(this, BRAND, { value: true })
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
  }
}

export function checkFilePath(path: unknown): asserts path is string {
  const problem = filePathProblem(path)
  if (problem) throw new FilesError('invalid_path', problem)
}

async function failure(res: Response): Promise<FilesError> {
  const body = (await res.json().catch(() => undefined)) as FilesResponse | undefined
  if (body && body.ok === false) return new FilesError(body.error.code, body.error.message)
  return new FilesError('unavailable', `The host could not handle the file request: HTTP ${res.status}`)
}

// ctx.files in a runtime VM: calls to the host's internal endpoint. Uploads
// and downloads are streamed, so files can be larger than other internal calls.
export function createFilesClient(baseUrl: string, fetchImpl: typeof fetch = fetch): Files {
  async function call<T>(request: FilesRequest): Promise<T> {
    const res = await fetchImpl(new URL(FILES_PATH, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = (await res.clone().json().catch(() => undefined)) as FilesResponse | undefined
    if (res.ok && body?.ok) return body.result as T
    throw await failure(res)
  }

  return {
    async put(path: string, body: FileBody): Promise<FileInfo> {
      checkFilePath(path)
      const stream = body instanceof ReadableStream
      const res = await fetchImpl(new URL(fileUrlPath(path), baseUrl), {
        method: 'PUT',
        body: body as RequestInit['body'],
        // fetch refuses a stream body without it.
        ...(stream ? { duplex: 'half' } : {}),
      } as RequestInit)
      if (!res.ok) throw await failure(res)
      return ((await res.json()) as { result: FileInfo }).result
    },

    async get(path: string): Promise<StoredFile | undefined> {
      checkFilePath(path)
      const res = await fetchImpl(new URL(fileUrlPath(path), baseUrl))
      if (!res.ok) {
        const error = await failure(res)
        if (error.code === 'not_found') return undefined
        throw error
      }
      return {
        path,
        size: Number(res.headers.get(FILE_SIZE_HEADER) ?? 0),
        modified: res.headers.get(FILE_MODIFIED_HEADER) ?? '',
        body: res.body ?? new Blob([]).stream(),
        bytes: async () => new Uint8Array(await res.arrayBuffer()),
        text: () => res.text(),
      }
    },

    async stat(path: string): Promise<FileInfo | undefined> {
      checkFilePath(path)
      return (await call<FileInfo | null>({ action: 'stat', path })) ?? undefined
    },

    async delete(path: string): Promise<boolean> {
      checkFilePath(path)
      return call<boolean>({ action: 'delete', path })
    },

    list(options: ListFilesOptions = {}): Promise<FileInfo[]> {
      return call<FileInfo[]>({ action: 'list', prefix: options.prefix, after: options.after, limit: options.limit })
    },
  }
}
