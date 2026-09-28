import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  deleteCheckoutFile,
  editCheckoutFile,
  listCheckoutFiles,
  readCheckoutFile,
  searchCheckout,
  writeCheckoutFile,
} from './files.ts'

let base: string
let root: string
let outside: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'hobwork-files-'))
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
    await expect(readCheckoutFile(root, path)).rejects.toThrow(/outside the project|relative|\.git/)
    await expect(writeCheckoutFile(root, path, 'x')).rejects.toThrow(/outside the project|relative|\.git/)
  },
)

test('does not follow symlinks out of the checkout', async () => {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
  symlinkSync(outside, join(root, 'dir'))

  await expect(readCheckoutFile(root, 'link.txt')).rejects.toThrow('symlink')
  await expect(readCheckoutFile(root, 'dir/secret.txt')).rejects.toThrow('symlink')
  await expect(writeCheckoutFile(root, 'link.txt', 'x')).rejects.toThrow('symlink')
  await expect(writeCheckoutFile(root, 'dir/new.txt', 'x')).rejects.toThrow('symlink')
  await expect(writeCheckoutFile(root, 'dir/sub/new.txt', 'x')).rejects.toThrow('symlink')
  await expect(listCheckoutFiles(root, 'dir', true)).rejects.toThrow('symlink')
  await expect(searchCheckout(root, { path: 'dir', pattern: 'secret', ignoreCase: false, maxMatches: 10 })).rejects.toThrow(
    'symlink',
  )
  expect(
    (await searchCheckout(root, { path: '.', pattern: 'secret', ignoreCase: false, maxMatches: 10 })).matches,
  ).toEqual([])
  expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')

  await deleteCheckoutFile(root, 'link.txt')
  expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
})

test('follows symlinks that stay inside the checkout', async () => {
  symlinkSync(join(root, 'src/a.ts'), join(root, 'alias.ts'))
  expect((await readCheckoutFile(root, 'alias.ts')).toString()).toBe('export const a = 1\n')
})

test('edit_file requires a unique match unless replacing all', async () => {
  await writeCheckoutFile(root, 'x.txt', 'a b a')
  await expect(editCheckoutFile(root, 'x.txt', 'a', 'c', false)).rejects.toThrow('occurs 2 times')
  await expect(editCheckoutFile(root, 'x.txt', 'z', 'c', false)).rejects.toThrow('not found')
  expect(await editCheckoutFile(root, 'x.txt', 'b', '$&', false)).toEqual({ replacements: 1 })
  expect(await editCheckoutFile(root, 'x.txt', 'a', 'c', true)).toEqual({ replacements: 2 })
  expect(readFileSync(join(root, 'x.txt'), 'utf8')).toBe('c $& c')
})

test('search stops at a pathological pattern instead of blocking the host', async () => {
  writeFileSync(join(root, 'slow.txt'), `${'a'.repeat(40)}!\n`)
  const search = searchCheckout(
    root,
    { path: '.', pattern: '^(a+)+$', ignoreCase: false, maxMatches: 10 },
    500,
  )
  let ticks = 0
  const interval = setInterval(() => ticks++, 50)
  await expect(search).rejects.toThrow('timed out')
  clearInterval(interval)
  expect(ticks).toBeGreaterThan(3)
})
