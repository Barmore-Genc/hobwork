import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { runFileRequest, type FileRequest } from '../src/workspace-tools/files.ts'

const MAIN = resolve(import.meta.dirname, '../src/workspace-tools/main.ts')

let base: string
let root: string
let outside: string

function run(request: FileRequest) {
  return runFileRequest(root, request)
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'hobwork-tools-'))
  root = join(base, 'files')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

test.each(['../outside/secret.txt', 'src/../../outside/secret.txt', '/etc/passwd', '.git/config', 'a/.git/HEAD'])(
  'rejects path %j',
  async (path) => {
    await expect(run({ op: 'read', path })).rejects.toThrow(/outside the hob|relative|\.git/)
    await expect(run({ op: 'write', path, content: 'x' })).rejects.toThrow(/outside the hob|relative|\.git/)
  },
)

test('does not follow symlinks out of the workspace', async () => {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
  symlinkSync(outside, join(root, 'dir'))
  const search = (path: string) => run({ op: 'search', path, pattern: 'secret', ignoreCase: false, maxMatches: 10 })

  await expect(run({ op: 'read', path: 'link.txt' })).rejects.toThrow('symlink')
  await expect(run({ op: 'read', path: 'dir/secret.txt' })).rejects.toThrow('symlink')
  await expect(run({ op: 'write', path: 'link.txt', content: 'x' })).rejects.toThrow('symlink')
  await expect(run({ op: 'write', path: 'dir/new.txt', content: 'x' })).rejects.toThrow('symlink')
  await expect(run({ op: 'write', path: 'dir/sub/new.txt', content: 'x' })).rejects.toThrow('symlink')
  await expect(run({ op: 'list', path: 'dir', recursive: true })).rejects.toThrow('symlink')
  await expect(search('dir')).rejects.toThrow('symlink')
  expect(await search('.')).toMatchObject({ matches: [] })
  expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')

  await run({ op: 'delete', path: 'link.txt' })
  expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
})

test('follows symlinks that stay inside the workspace', async () => {
  symlinkSync(join(root, 'src/a.ts'), join(root, 'alias.ts'))
  expect(await run({ op: 'read', path: 'alias.ts' })).toMatchObject({ content: 'export const a = 1\n' })
})

test('reads text, reports binary files and refuses directories and FIFOs', async () => {
  writeFileSync(join(root, 'bin'), Buffer.from([1, 0, 2]))
  execFileSync('mkfifo', [join(root, 'pipe')])
  expect(await run({ op: 'read', path: 'src/a.ts' })).toEqual({ op: 'read', binary: false, content: 'export const a = 1\n', size: 19 })
  expect(await run({ op: 'read', path: 'bin' })).toEqual({ op: 'read', binary: true, size: 3 })
  await expect(run({ op: 'read', path: 'src' })).rejects.toThrow('is a directory')
  await expect(run({ op: 'read', path: 'pipe' })).rejects.toThrow('not a regular file')
  await expect(run({ op: 'read', path: 'nope' })).rejects.toThrow('does not exist')
})

test('writes create parent directories and report whether the file was new', async () => {
  expect(await run({ op: 'write', path: 'a/b/c.txt', content: 'x' })).toEqual({ op: 'write', created: true })
  expect(await run({ op: 'write', path: 'a/b/c.txt', content: 'y' })).toEqual({ op: 'write', created: false })
  expect(readFileSync(join(root, 'a/b/c.txt'), 'utf8')).toBe('y')
  await expect(run({ op: 'write', path: 'src', content: 'x' })).rejects.toThrow('is a directory')
})

test('edit requires a unique match unless replacing all', async () => {
  await run({ op: 'write', path: 'x.txt', content: 'a b a' })
  const edit = (oldString: string, newString: string, replaceAll: boolean) =>
    run({ op: 'edit', path: 'x.txt', oldString, newString, replaceAll })
  await expect(edit('a', 'c', false)).rejects.toThrow('occurs 2 times')
  await expect(edit('z', 'c', false)).rejects.toThrow('not found')
  expect(await edit('b', '$&', false)).toEqual({ op: 'edit', replacements: 1 })
  expect(await edit('a', 'c', true)).toEqual({ op: 'edit', replacements: 2 })
  expect(readFileSync(join(root, 'x.txt'), 'utf8')).toBe('c $& c')
})

test('lists files in order, skipping node_modules and .git when recursive', async () => {
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
  writeFileSync(join(root, 'node_modules/pkg/index.js'), '')
  writeFileSync(join(root, 'b.txt'), '')
  expect(await run({ op: 'list', path: '.', recursive: true })).toEqual({
    op: 'list',
    entries: ['b.txt', 'src/a.ts'],
    truncated: false,
  })
  expect(await run({ op: 'list', path: '.', recursive: false })).toMatchObject({
    entries: ['b.txt', 'node_modules/', 'src/'],
  })
})

test('search finds lines with globs and limits, and rejects bad patterns', async () => {
  writeFileSync(join(root, 'src/b.md'), 'a\nexport const b = 2\n')
  const search = (options: Partial<Extract<FileRequest, { op: 'search' }>>) =>
    run({ op: 'search', path: '.', pattern: 'export', ignoreCase: false, maxMatches: 10, ...options })
  expect(await search({})).toMatchObject({ matches: ['src/a.ts:1: export const a = 1', 'src/b.md:2: export const b = 2'] })
  expect(await search({ glob: '*.ts' })).toMatchObject({ matches: ['src/a.ts:1: export const a = 1'] })
  expect(await search({ maxMatches: 1 })).toMatchObject({ truncated: true })
  await expect(search({ pattern: '(' })).rejects.toThrow('Invalid regular expression')
})

test('the tool prints one JSON line and reports errors', () => {
  const call = (request: unknown) =>
    JSON.parse(
      spawnSync('node', ['--disable-warning=ExperimentalWarning', MAIN, 'files'], {
        cwd: root,
        input: JSON.stringify(request),
        encoding: 'utf8',
      }).stdout,
    )
  expect(call({ op: 'read', path: 'src/a.ts' })).toMatchObject({ ok: true, result: { content: 'export const a = 1\n' } })
  expect(call({ op: 'read', path: '../x' })).toEqual({ ok: false, user: true, error: 'Path "../x" is outside the hob' })
})
