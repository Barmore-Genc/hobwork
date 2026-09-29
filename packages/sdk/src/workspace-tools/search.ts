import { matchesGlob } from 'node:path'

export type SearchRequest = {
  pattern: string
  ignoreCase: boolean
  glob?: string
  maxMatches: number
}

export type SearchResult = {
  matches: string[]
  truncated: boolean
  filesSearched: number
}

export const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_LINE_LENGTH = 300

export function globMatches(glob: string, path: string): boolean {
  if (matchesGlob(path, glob)) return true
  // A glob without a slash, like "*.ts", matches files at any depth.
  return !glob.includes('/') && matchesGlob(path.slice(path.lastIndexOf('/') + 1), glob)
}

export class Searcher {
  readonly result: SearchResult = { matches: [], truncated: false, filesSearched: 0 }
  readonly #request: SearchRequest
  readonly #regex: RegExp

  constructor(request: SearchRequest) {
    this.#request = request
    this.#regex = new RegExp(request.pattern, request.ignoreCase ? 'i' : '')
  }

  wantsFile(rel: string): boolean {
    return !this.#request.glob || globMatches(this.#request.glob, rel)
  }

  // Returns false once the match limit is reached. Files that are too big or
  // binary are skipped.
  addFile(rel: string, content: Uint8Array | undefined): boolean {
    if (!content || content.length > MAX_SEARCH_FILE_BYTES || content.subarray(0, 8000).includes(0)) return true
    this.result.filesSearched++
    const lines = Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (!this.#regex.test(line)) continue
      if (this.result.matches.length >= this.#request.maxMatches) {
        this.result.truncated = true
        return false
      }
      const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line
      this.result.matches.push(`${rel}:${index + 1}: ${text}`)
    }
    return true
  }
}
