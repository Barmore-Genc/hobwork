import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createAgentToken } from './agents.ts'
import { createApp } from './app.ts'
import { git, GitError, HOBWORK_IDENTITY } from './git.ts'
import { repoPath } from './host.ts'
import { createProject } from './projects.ts'
import { createTestHost } from './test-host.ts'

let host: ReturnType<typeof createTestHost>
let close: () => Promise<void>
let base: string
let token: string
let clientDir: string

const url = (password: string, project = 'filament') =>
  `${base.replace('://', `://agent:${encodeURIComponent(password)}@`)}/git/${project}.git`

function client(args: string[], cwd?: string) {
  return git(args, { cwd, env: HOBWORK_IDENTITY })
}

async function stderrOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitError)
  return (err as GitError).stderr
}

beforeAll(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
  token = createAgentToken(host.db, 'test-agent').token
  const server = createApp(host)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise((resolve) => server.close(() => resolve()))
  clientDir = mkdtempSync(join(tmpdir(), 'hobwork-client-'))
})

afterAll(async () => {
  await close()
  host.dispose()
  rmSync(clientDir, { recursive: true, force: true })
})

test('clones with an agent token', async () => {
  await client(['clone', '--quiet', url(token), join(clientDir, 'clone')])
  expect(readFileSync(join(clientDir, 'clone', 'AGENTS.md'), 'utf8')).toContain('Hobwork')
})

test('pushes a branch, including a body larger than one request buffer', async () => {
  const work = join(clientDir, 'clone')
  await client(['switch', '--quiet', '-c', 'feature/big'], work)
  // Random data does not compress, so the push exceeds http.postBuffer and is sent chunked.
  writeFileSync(join(work, 'blob.bin'), randomBytes(2 * 1024 * 1024))
  await client(['add', '.'], work)
  await client(['commit', '--quiet', '-m', 'Add blob'], work)
  await client(['push', '--quiet', 'origin', 'feature/big'], work)

  const repo = repoPath(host, 'filament')
  expect(await git(['--git-dir', repo, 'log', '--format=%s', '-1', 'feature/big'])).toBe('Add blob\n')
})

test('rejects pushes to main', async () => {
  const work = join(clientDir, 'clone')
  await client(['switch', '--quiet', 'main'], work)
  writeFileSync(join(work, 'direct.txt'), 'nope\n')
  await client(['add', '.'], work)
  await client(['commit', '--quiet', '-m', 'Direct to main'], work)
  const before = await git(['--git-dir', repoPath(host, 'filament'), 'rev-parse', 'main'])

  const stderr = await stderrOf(client(['push', '--quiet', 'origin', 'main'], work))
  expect(stderr).toContain('Pushing to main is not allowed')
  expect(await git(['--git-dir', repoPath(host, 'filament'), 'rev-parse', 'main'])).toBe(before)
})

test('rejects deleting main', async () => {
  const work = join(clientDir, 'clone')
  const stderr = await stderrOf(client(['push', '--quiet', 'origin', ':main'], work))
  expect(stderr).toMatch(/not allowed|refusing to delete the current branch/)
})

test('rejects a bad token', async () => {
  const stderr = await stderrOf(
    client(['ls-remote', url('hw_not-a-real-token')]),
  )
  expect(stderr).toContain('Authentication failed')
})

test('rejects requests without credentials', async () => {
  const res = await fetch(`${base}/git/filament.git/info/refs?service=git-upload-pack`)
  expect(res.status).toBe(401)
  expect(res.headers.get('www-authenticate')).toContain('Basic')
})

test('returns 404 for unknown projects and malformed paths', async () => {
  const auth = { authorization: `Basic ${Buffer.from(`agent:${token}`).toString('base64')}` }
  expect((await fetch(`${base}/git/missing.git/info/refs?service=git-upload-pack`, { headers: auth })).status).toBe(404)
  expect((await fetch(`${base}/git/Filament.git/info/refs`, { headers: auth })).status).toBe(404)
})
