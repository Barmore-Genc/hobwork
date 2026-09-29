import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createFileTools, readRegularFile } from './files.ts'
import { createProject } from './projects.ts'
import { createBranch } from './repo.ts'
import { createTestHost } from './test-host.ts'
import { seedBranch, seedMain } from './test-project.ts'
import { hostWorkspaceVm } from './test-workspace-vm.ts'
import { createWorkspaceManager, type ExecWorkspaceVm, type Workspace } from './workspaces.ts'

let base: string
let root: string
let outside: string
let host: ReturnType<typeof createTestHost>
let started: Workspace[]

const WRITE = { readOnly: false }
const READ_ONLY = { readOnly: true }

function tools(searchTimeoutMs?: number) {
  const workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, {
    startVm: async (workspace) => {
      started.push(workspace)
      return hostWorkspaceVm(host, workspace)
    },
  })
  return { workspaces, files: createFileTools(host, workspaces, { searchTimeoutMs }) }
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'hobwork-files-'))
  root = join(base, 'files')
  outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  host = createTestHost()
  started = []
  await createProject(host, 'filament')
  await seedMain(host, 'filament', {
    'package.json': '{}',
    'hobwork.json': '{}',
    'src/a.ts': 'export const a = 1\n',
    'src/b.md': 'first\nexport const b = 2\n',
    'src/deep/c.ts': 'export const c = 3\n',
    'node_modules/pkg/index.js': 'export const skipped = true\n',
    'z.txt': 'last\n',
  })
  await createBranch(host, 'filament', 'work')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  host.dispose()
})

test('reads main and committed branches from git without starting a VM', async () => {
  const { files } = tools()
  expect(await files.read('filament', 'main', 'src/a.ts', WRITE)).toEqual({ binary: false, content: 'export const a = 1\n', size: 19 })
  expect(await files.read('filament', 'work', 'src/a.ts', WRITE)).toMatchObject({ content: 'export const a = 1\n' })
  expect(await files.list('filament', 'main', '.', true, WRITE)).toEqual({
    entries: ['hobwork.json', 'package.json', 'src/a.ts', 'src/b.md', 'src/deep/c.ts', 'z.txt'],
    truncated: false,
  })
  expect((await files.list('filament', 'main', 'src', false, WRITE)).entries).toEqual(['src/a.ts', 'src/b.md', 'src/deep/'])
  expect(await files.search('filament', 'main', { path: '.', pattern: 'export', ignoreCase: false, maxMatches: 10 }, WRITE)).toMatchObject({
    matches: ['src/a.ts:1: export const a = 1', 'src/b.md:2: export const b = 2', 'src/deep/c.ts:1: export const c = 3'],
    filesSearched: 6,
  })
  expect(started).toEqual([])
})

test('reports missing paths, directories, binary files and paths outside the hob', async () => {
  await seedBranch(host, 'filament', 'bin', { 'a.bin': '\0\0' })
  const { files } = tools()
  await expect(files.read('filament', 'main', 'nope.ts', WRITE)).rejects.toThrow('"nope.ts" does not exist')
  await expect(files.read('filament', 'main', 'src', WRITE)).rejects.toThrow('is a directory')
  await expect(files.list('filament', 'main', 'src/a.ts', true, WRITE)).rejects.toThrow('not a directory')
  await expect(files.list('filament', 'main', 'nope', true, WRITE)).rejects.toThrow('does not exist')
  await expect(files.read('filament', 'nope', 'a', WRITE)).rejects.toThrow('does not exist in filament')
  expect(await files.read('filament', 'bin', 'a.bin', WRITE)).toEqual({ binary: true, size: 2 })
  for (const path of ['../outside/secret.txt', '/etc/passwd', '.git/config', 'a/.git/HEAD']) {
    await expect(files.read('filament', 'main', path, WRITE)).rejects.toThrow(/outside the hob|relative|\.git/)
  }
  await expect(files.search('filament', 'main', { path: '.', pattern: '(', ignoreCase: false, maxMatches: 1 }, WRITE)).rejects.toThrow(
    'Invalid regular expression',
  )
})

test('changes run in the VM and later reads see them there', async () => {
  const { files } = tools()
  await expect(files.write('filament', 'main', 'x.txt', 'x')).rejects.toThrow('changes only by merging')
  expect(await files.write('filament', 'work', 'src/new.ts', 'export const n = 1\n')).toEqual({ created: true })
  expect(await files.edit('filament', 'work', 'src/new.ts', 'n = 1', 'n = 2', false)).toEqual({ replacements: 1 })
  expect(started).toHaveLength(1)

  expect(await files.read('filament', 'work', 'src/new.ts', WRITE)).toMatchObject({ content: 'export const n = 2\n' })
  expect((await files.list('filament', 'work', 'src', true, WRITE)).entries).toContain('src/new.ts')
  expect((await files.search('filament', 'work', { path: 'src', pattern: 'n = 2', ignoreCase: false, maxMatches: 5 }, WRITE)).matches).toEqual([
    'src/new.ts:1: export const n = 2',
  ])

  await files.remove('filament', 'work', 'src/new.ts')
  await expect(files.read('filament', 'work', 'src/new.ts', WRITE)).rejects.toThrow('does not exist')
})

test('read-only credentials and main only see committed files', async () => {
  const { files } = tools()
  await files.write('filament', 'work', 'src/a.ts', 'export const a = 99\n')
  expect(await files.read('filament', 'work', 'src/a.ts', WRITE)).toMatchObject({ content: 'export const a = 99\n' })
  expect(await files.read('filament', 'work', 'src/a.ts', READ_ONLY)).toMatchObject({ content: 'export const a = 1\n' })
  expect(await files.read('filament', 'main', 'src/a.ts', WRITE)).toMatchObject({ content: 'export const a = 1\n' })
})

test('a committed workspace reads from git again', async () => {
  const { files, workspaces } = tools()
  await files.write('filament', 'work', 'src/a.ts', 'export const a = 99\n')
  await workspaces.commit('filament', 'work', 'Change a', { id: 1, name: 'Agent' })
  const before = started.length
  expect(await files.read('filament', 'work', 'src/a.ts', WRITE)).toMatchObject({ content: 'export const a = 99\n' })
  expect(started).toHaveLength(before)
})

test('the VM refuses to follow symlinks out of the workspace', async () => {
  const { files, workspaces } = tools()
  const workspace = await workspaces.open('filament', 'work')
  symlinkSync(outside, join(workspace.dir, 'escape'))
  await workspaces.files('filament', 'work', { op: 'write', path: 'touch.txt', content: '' })
  await expect(files.read('filament', 'work', 'escape/secret.txt', WRITE)).rejects.toThrow('symlink')
})

test('search stops at a pathological pattern instead of blocking the host', async () => {
  await seedBranch(host, 'filament', 'slow', { 'slow.txt': `${'a'.repeat(40)}!\n` })
  const { files } = tools(500)
  const search = files.search('filament', 'slow', { path: '.', pattern: '^(a+)+$', ignoreCase: false, maxMatches: 10 }, WRITE)
  let ticks = 0
  const interval = setInterval(() => ticks++, 50)
  await expect(search).rejects.toThrow('timed out')
  clearInterval(interval)
  expect(ticks).toBeGreaterThan(3)
})

test('answers from the VM are checked', async () => {
  const workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, {
    startVm: async () => ({
      stop: async () => {},
      exec: async (_command, { onOutput }) => {
        onOutput?.('stdout', JSON.stringify({ ok: true, result: { op: 'read', binary: false, content: 5, size: 1 } }))
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }),
  })
  await expect(workspaces.files('filament', 'work', { op: 'read', path: 'a' })).rejects.toThrow('unexpected answer')
})

test('a tool that prints too much is stopped', async () => {
  const workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, {
    startVm: async () => ({
      stop: async () => {},
      exec: async (_command, { onOutput, signal }) => {
        for (let i = 0; i < 20 && !signal?.aborted; i++) onOutput?.('stdout', 'x'.repeat(1024 * 1024))
        return { exitCode: 143, stdout: '', stderr: '' }
      },
    }),
  })
  await expect(workspaces.files('filament', 'work', { op: 'read', path: 'a' })).rejects.toThrow('too much data')
})

test('tool errors from the VM reach the caller as they are', async () => {
  const { workspaces } = tools()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(workspaces.files('filament', 'work', { op: 'read', path: 'missing' })).rejects.toThrow('"missing" does not exist')
})

test('readRegularFile reads a normal file', async () => {
  writeFileSync(join(root, 'hobwork.json'), '{"egress":[]}')
  expect(await readRegularFile(join(root, 'hobwork.json'), 'hobwork.json')).toBe('{"egress":[]}')
})

test('readRegularFile refuses a symlink', async () => {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'hobwork.json'))
  await expect(readRegularFile(join(root, 'hobwork.json'), 'hobwork.json')).rejects.toThrow('hobwork.json is a symlink')
})

test('readRegularFile refuses a directory', async () => {
  mkdirSync(join(root, 'package.json'))
  await expect(readRegularFile(join(root, 'package.json'), 'package.json')).rejects.toThrow(
    'package.json is not a regular file',
  )
})

test('readRegularFile refuses a FIFO without blocking', async () => {
  execFileSync('mkfifo', [join(root, 'hobwork.json')])
  await expect(readRegularFile(join(root, 'hobwork.json'), 'hobwork.json')).rejects.toThrow(
    'hobwork.json is not a regular file',
  )
})

test('readRegularFile refuses an oversized file', async () => {
  writeFileSync(join(root, 'package.json'), 'x'.repeat(101))
  await expect(readRegularFile(join(root, 'package.json'), 'package.json', 100)).rejects.toThrow(
    'package.json is larger than 100 bytes',
  )
})
