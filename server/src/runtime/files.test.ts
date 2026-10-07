import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { FILE_MODIFIED_HEADER, FILE_SIZE_HEADER, fileUrlPath, MAX_FILE_BYTES } from '../../../packages/sdk/src/runner/protocol.ts'
import { createFilesClient, FilesError } from '../../../packages/sdk/src/runner/files-client.ts'
import { filesResponse, findStaticMount, streamsFileBody, UPLOADS_DIR } from './files.ts'

let root: string
let files: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hobwork-files-'))
  files = join(root, 'files')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const BASE = 'http://hobwork.internal'
const client = () => createFilesClient(BASE, async (input, init) => filesResponse(new Request(input, init), files))

function put(path: string, body: RequestInit['body'], headers: Record<string, string> = {}, max?: number) {
  const request = new Request(`${BASE}/v1/files/${path}`, { method: 'PUT', body, headers, duplex: 'half' } as RequestInit)
  return filesResponse(request, files, max)
}

test('stores, reads, lists and deletes files', async () => {
  const ctx = client()
  const stored = await ctx.put('photos/2026/cat.jpg', new Uint8Array([1, 2, 3]))
  expect(stored).toMatchObject({ path: 'photos/2026/cat.jpg', size: 3 })
  expect(Date.parse(stored.modified)).not.toBeNaN()
  expect(readFileSync(join(files, 'photos', '2026', 'cat.jpg'))).toEqual(Buffer.from([1, 2, 3]))

  await ctx.put('notes.txt', 'héllo')
  const file = await ctx.get('notes.txt')
  expect(file).toMatchObject({ path: 'notes.txt', size: 6 })
  expect(await file!.text()).toBe('héllo')
  expect(Array.from(await (await ctx.get('photos/2026/cat.jpg'))!.bytes())).toEqual([1, 2, 3])
  expect(await ctx.stat('notes.txt')).toMatchObject({ path: 'notes.txt', size: 6 })

  // Replacing keeps one file.
  await ctx.put('notes.txt', new Blob(['bye']))
  expect(await (await ctx.get('notes.txt'))!.text()).toBe('bye')

  expect(await ctx.get('missing.txt')).toBeUndefined()
  expect(await ctx.stat('missing.txt')).toBeUndefined()
  expect(await ctx.stat('photos')).toBeUndefined()

  expect((await ctx.list()).map((f) => f.path)).toEqual(['notes.txt', 'photos/2026/cat.jpg'])
  expect(await ctx.delete('photos/2026/cat.jpg')).toBe(true)
  expect(await ctx.delete('photos/2026/cat.jpg')).toBe(false)
  // Empty directories go with the file, but not the files directory itself.
  expect(readdirSync(files)).toEqual(['notes.txt'])
  // Uploads leave nothing behind.
  expect(readdirSync(join(root, UPLOADS_DIR))).toEqual([])
})

test('streams uploads and answers downloads with their size and time', async () => {
  const chunks = ['a', 'b', 'c']
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift()
      if (next === undefined) controller.close()
      else controller.enqueue(new TextEncoder().encode(next))
    },
  })
  expect(await client().put('stream.txt', stream)).toMatchObject({ size: 3 })
  const res = await filesResponse(new Request(`${BASE}${fileUrlPath('stream.txt')}`), files)
  expect(res.status).toBe(200)
  expect(res.headers.get(FILE_SIZE_HEADER)).toBe('3')
  expect(Date.parse(res.headers.get(FILE_MODIFIED_HEADER)!)).not.toBeNaN()
  expect(await res.text()).toBe('abc')
})

test('lists in path order with a prefix and pages', async () => {
  const ctx = client()
  for (const path of ['a.txt', 'a/b.txt', 'a/c/d.txt', 'a-b.txt', 'b.txt', 'ab/x.txt']) await ctx.put(path, path)
  const paths = async (options?: Parameters<ReturnType<typeof client>['list']>[0]) => (await ctx.list(options)).map((f) => f.path)
  expect(await paths()).toEqual(['a-b.txt', 'a.txt', 'a/b.txt', 'a/c/d.txt', 'ab/x.txt', 'b.txt'])
  expect(await paths({ prefix: 'a/' })).toEqual(['a/b.txt', 'a/c/d.txt'])
  expect(await paths({ prefix: 'a' })).toEqual(['a-b.txt', 'a.txt', 'a/b.txt', 'a/c/d.txt', 'ab/x.txt'])
  expect(await paths({ prefix: 'a/c/d' })).toEqual(['a/c/d.txt'])
  expect(await paths({ prefix: 'nope/' })).toEqual([])
  expect(await paths({ limit: 2 })).toEqual(['a-b.txt', 'a.txt'])
  expect(await paths({ after: 'a.txt', limit: 2 })).toEqual(['a/b.txt', 'a/c/d.txt'])
  // A prefix no path can have finds nothing, without walking outside.
  expect(await paths({ prefix: '../' })).toEqual([])
  for (const options of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { prefix: 'a b' }, { after: 'ä' }]) {
    await expect(ctx.list(options), JSON.stringify(options)).rejects.toMatchObject({ code: 'invalid_path' })
  }
})

test('refuses paths that are not plain file paths', async () => {
  const ctx = client()
  for (const path of ['', '/abs', 'a//b', '.hidden', 'a/../b', 'a/./b', '..', 'a/', 'a b', 'a\\b', 'ä', 'x'.repeat(256), 'a/'.repeat(16) + 'a']) {
    await expect(ctx.put(path, 'x'), path).rejects.toMatchObject({ name: 'FilesError', code: 'invalid_path' })
    await expect(ctx.get(path), path).rejects.toBeInstanceOf(FilesError)
  }
  // Encoded traversal is refused by the host too.
  for (const path of ['..%2f..%2fhobwork.db', '%2e%2e/x', 'a%2F..%2F..%2Fx', '%00', 'a/%2e']) {
    expect((await put(path, 'x')).status, path).toBe(400)
    expect((await filesResponse(new Request(`${BASE}/v1/files/${path}`), files)).status, path).toBe(400)
  }
  expect(readdirSync(root).filter((name) => name !== UPLOADS_DIR)).toEqual([])
})

test('a path cannot be a file and a directory', async () => {
  const ctx = client()
  await ctx.put('a', 'file')
  await expect(ctx.put('a/b', 'x')).rejects.toMatchObject({ code: 'conflict' })
  await ctx.put('c/d', 'x')
  await expect(ctx.put('c', 'x')).rejects.toMatchObject({ code: 'conflict' })
  // Once the directory is empty again, the name is free.
  await ctx.delete('c/d')
  await ctx.put('c', 'now a file')
  expect(await (await ctx.get('c'))!.text()).toBe('now a file')
})

test('refuses files over the limit and keeps the old contents', async () => {
  const max = 1024 * 1024
  await client().put('big.bin', 'old')
  expect((await put('big.bin', 'x', { 'content-length': String(MAX_FILE_BYTES + 1) })).status).toBe(413)
  // Without a length, the stream is cut off once it passes the limit.
  let sent = 0
  const chunk = new Uint8Array(64 * 1024)
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += chunk.length
      controller.enqueue(chunk)
    },
  })
  const streamed = await put('big.bin', endless, {}, max)
  expect(streamed.status).toBe(413)
  expect(await streamed.json()).toMatchObject({ ok: false, error: { code: 'too_large' } })
  expect(sent).toBeLessThan(max * 2)
  expect(readFileSync(join(files, 'big.bin'), 'utf8')).toBe('old')
  expect(readdirSync(join(root, UPLOADS_DIR))).toEqual([])
  expect((await put('big.bin', new Uint8Array(max), {}, max)).status).toBe(200)
})

test('does not follow links into the rest of the host', async () => {
  mkdirSync(files, { recursive: true })
  writeFileSync(join(root, 'secret'), 'host file')
  symlinkSync(join(root, 'secret'), join(files, 'link.txt'))
  const ctx = client()
  expect(await ctx.get('link.txt')).toBeUndefined()
  expect(await ctx.stat('link.txt')).toBeUndefined()
  expect(await ctx.list()).toEqual([])
  expect(await ctx.delete('link.txt')).toBe(false)
})

test('only file uploads stream', () => {
  expect(streamsFileBody(new Request(`${BASE}/v1/files/a.txt`, { method: 'PUT' }))).toBe(true)
  expect(streamsFileBody(new Request(`${BASE}/v1/files`, { method: 'POST' }))).toBe(false)
  expect(streamsFileBody(new Request(`${BASE}/v1/db`, { method: 'PUT' }))).toBe(false)
  expect(streamsFileBody(new Request(`${BASE}/v1/files/a.txt`))).toBe(false)
})

test('finds the mount with the longest matching prefix', () => {
  const mounts = [
    { prefix: '/photos/private', dir: 'private', public: false },
    { prefix: '/photos', dir: 'photos', public: true },
  ]
  expect(findStaticMount(mounts, '/photos/cat.jpg')?.dir).toBe('photos')
  expect(findStaticMount(mounts, '/photos/private/cat.jpg')?.dir).toBe('private')
  expect(findStaticMount(mounts, '/photos')?.dir).toBe('photos')
  expect(findStaticMount(mounts, '/photosx/cat.jpg')).toBeUndefined()
  expect(findStaticMount(mounts, '/')).toBeUndefined()
})
