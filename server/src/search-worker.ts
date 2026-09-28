import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join, matchesGlob } from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'

export const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

export type SearchRequest = {
  // Real path of the directory or file to search, already checked to be inside the checkout.
  dir: string
  // Path of `dir` relative to the checkout root, used to report matches.
  prefix: string
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

const MAX_FILE_BYTES = 1024 * 1024
const MAX_LINE_LENGTH = 300

function globMatches(glob: string, path: string): boolean {
  if (matchesGlob(path, glob)) return true
  // A glob without a slash, like "*.ts", matches files at any depth.
  return !glob.includes('/') && matchesGlob(path.slice(path.lastIndexOf('/') + 1), glob)
}

async function readSmallFile(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if ((await handle.stat()).size > MAX_FILE_BYTES) return undefined
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

export async function search(request: SearchRequest): Promise<SearchResult> {
  const regex = new RegExp(request.pattern, request.ignoreCase ? 'i' : '')
  const result: SearchResult = { matches: [], truncated: false, filesSearched: 0 }

  async function searchFile(path: string, rel: string): Promise<void> {
    if (request.glob && !globMatches(request.glob, rel)) return
    const content = await readSmallFile(path).catch(() => undefined)
    if (!content || content.subarray(0, 8000).includes(0)) return
    result.filesSearched++
    const lines = content.toString('utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (!regex.test(line)) continue
      if (result.matches.length >= request.maxMatches) {
        result.truncated = true
        return
      }
      const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line
      result.matches.push(`${rel}:${index + 1}: ${text}`)
    }
  }

  // Symlinks are never followed; their targets may be outside the checkout.
  async function walk(dir: string, prefix: string): Promise<void> {
    const children = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const child of children) {
      if (result.truncated) return
      const rel = prefix ? `${prefix}/${child.name}` : child.name
      if (child.isDirectory() && !SKIPPED_DIRS.has(child.name)) await walk(join(dir, child.name), rel)
      else if (child.isFile()) await searchFile(join(dir, child.name), rel)
    }
  }

  if ((await lstat(request.dir)).isDirectory()) await walk(request.dir, request.prefix)
  else await searchFile(request.dir, request.prefix)
  return result
}

if (!isMainThread && parentPort) {
  parentPort.postMessage(await search(workerData as SearchRequest))
}
