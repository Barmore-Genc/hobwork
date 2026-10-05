import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ensureAgent } from './agents.ts'
import { createAppOrigins } from './apps/origins.ts'
import { createDelivery } from './delivery.ts'
import { git } from './git.ts'
import { repoPath } from './host.ts'
import { startHostPipelineVm } from './pipeline/host-backend.ts'
import { createProject } from './projects.ts'
import { createBranch } from './repo.ts'
import { appendLog } from './runtime/logs.ts'
import { createTestHost } from './test-host.ts'
import { seedMain } from './test-project.ts'
import { startHostWorkspaceVm } from './test-workspace-vm.ts'
import { createWorkspaceApi } from './workspace-api.ts'
import { checkPushCommands } from './workspace-git.ts'
import { createWorkspaceManager, type ExecWorkspaceVm, type WorkspaceSession } from './workspaces.ts'

vi.setConfig({ testTimeout: 30_000 })

const CLI = resolve(import.meta.dirname, '../../packages/sdk/src/cli/main.ts')

let host: ReturnType<typeof createTestHost>
let workspaces: ReturnType<typeof createWorkspaceManager<ExecWorkspaceVm>>
let server: Server
let internalUrl: string
let session: WorkspaceSession
let handler: (request: Request) => Response | Promise<Response>

// Serves the handler of the filament/spools workspace VM over local HTTP, the
// way Gondolin answers hobwork.internal inside the VM: bodies stream both ways,
// and chunked request bodies arrive without framing headers.
beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
  await seedMain(host, 'filament')
  await createBranch(host, 'filament', 'spools')
  workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, { startVm: startHostWorkspaceVm(host) })
  await workspaces.open('filament', 'spools')
  const delivery = createDelivery(host, { workspaces, pipeline: { startVm: startHostPipelineVm } })
  handler = createWorkspaceApi({
    host,
    workspaces,
    delivery,
    appOrigin: createAppOrigins('https://apps.example.com').origin,
  })({ project: 'filament', branch: 'spools' })
  server = createServer(async (req, res) => {
    const headers = new Headers(req.headers as Record<string, string>)
    headers.delete('transfer-encoding')
    headers.delete('connection')
    const response = await handler(
      new Request(`http://hobwork.internal${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' ? undefined : (Readable.toWeb(req) as ReadableStream),
        duplex: 'half',
      }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) Readable.fromWeb(response.body as NodeReadableStream).pipe(res)
    else res.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  internalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  session = workspaces.openSession('filament', 'spools', ensureAgent(host.db, 'laptop'))
})

afterEach(async () => {
  session.close()
  await new Promise((done) => server.close(done))
  host.dispose()
})

type CliRun = { stdout: string; stderr: string; code: number }

function hobwork(args: string[], env: Record<string, string> = session.env): Promise<CliRun> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { PATH: process.env.PATH, HOBWORK_INTERNAL_URL: internalUrl, ...env } },
      (err, stdout, stderr) => done({ stdout, stderr, code: err ? Number(err.code) : 0 }),
    )
  })
}

function workspaceFile(path: string, content: string): void {
  const dir = workspaces.get('filament', 'spools')?.dir ?? ''
  writeFileSync(join(dir, path), content)
}

test('needs the session of a running command', async () => {
  expect(await hobwork(['status'], {})).toMatchObject({ code: 1, stderr: expect.stringContaining('session helper') })
  const forged = await hobwork(['status'], { HOBWORK_SESSION: 'forged' })
  expect(forged).toMatchObject({ code: 1, stderr: expect.stringContaining('only works in commands started over SSH') })
  session.close()
  expect((await hobwork(['status'])).code).toBe(1)
})

test('status, diff and commit as the session agent', async () => {
  const clean = await hobwork(['status'])
  expect(clean.code).toBe(0)
  expect(clean.stdout).toContain('Workspace filament/spools, working as laptop')
  expect(clean.stdout).toContain('No uncommitted changes')
  expect(clean.stdout).toContain('No pipeline runs for spools yet')
  expect(clean.stdout).toContain('App for spools (committed changes): https://spools--filament.apps.example.com')
  expect(clean.stdout).toContain('App for main: https://filament.apps.example.com')

  workspaceFile('src/b.ts', 'export const b = 2\n')
  expect((await hobwork(['status'])).stdout).toContain('?? src/b.ts')
  expect((await hobwork(['diff'])).stdout).toContain('+export const b = 2')

  const commit = await hobwork(['commit', '-m', 'Add b'])
  expect(commit).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Committed [0-9a-f]{40}\n$/) })
  const author = await git(['--git-dir', repoPath(host, 'filament'), 'log', '-1', '--format=%an %s', 'spools'])
  expect(author.trim()).toBe('laptop Add b')
  expect((await hobwork(['commit', 'Again'])).stdout).toBe('Nothing to commit\n')
})

test('merge runs the pipeline and fails with status 1 when there is nothing to merge', async () => {
  const nothing = await hobwork(['merge', 'Nothing'])
  expect(nothing).toMatchObject({ code: 1, stderr: expect.stringContaining('has no changes compared to main') })

  workspaceFile('src/b.ts', 'export const b = 2\n')
  await hobwork(['commit', 'Add b'])
  const merged = await hobwork(['merge', 'Add b'])
  expect(merged.code).toBe(0)
  expect(merged.stdout).toMatch(/^Merged spools into main as version 2/)
  expect((await hobwork(['status'])).stdout).toMatch(/main is at version 2 "Add b"[\s\S]*Last pipeline run for spools: #\d+ passed/)
})

test('logs, logs -f and invocations', async () => {
  appendLog(host, { project: 'filament', source: 'runtime', level: 'info', event: 'start', message: 'runtime started' })
  const logs = await hobwork(['logs'])
  expect(logs.code).toBe(0)
  expect(logs.stdout).toMatch(/INFO \[runtime start\] runtime started/)
  expect(await hobwork(['invocations'])).toMatchObject({ code: 0, stdout: 'No invocations yet\n' })

  appendLog(host, { project: 'filament', branch: 'spools', source: 'handler', level: 'info', message: 'preview line' })
  expect((await hobwork(['logs'])).stdout).not.toContain('preview line')
  expect((await hobwork(['logs', '-b', 'spools'])).stdout).toContain('preview line')
  const all = (await hobwork(['logs', '-b', '*'])).stdout
  expect(all).toContain('preview line')
  expect(all).toContain('runtime started')
  expect(await hobwork(['logs', '-b'])).toMatchObject({ code: 2, stderr: expect.stringContaining('-b needs a branch name') })

  const follow = spawn(process.execPath, [CLI, 'logs', '-f'], {
    env: { PATH: process.env.PATH, HOBWORK_INTERNAL_URL: internalUrl, ...session.env },
  })
  let output = ''
  follow.stdout.on('data', (chunk: Buffer) => (output += chunk))
  try {
    await vi.waitFor(() => expect(output).toContain('runtime started'))
    appendLog(host, { project: 'filament', source: 'handler', level: 'warn', message: 'spool low' })
    await vi.waitFor(() => expect(output).toContain('WARN [handler] spool low'))
  } finally {
    follow.kill()
  }
})

test('usage errors exit with status 2', async () => {
  expect(await hobwork(['nope'])).toMatchObject({ code: 2, stderr: expect.stringContaining('Unknown command "nope"') })
  expect(await hobwork(['commit'])).toMatchObject({ code: 2, stderr: expect.stringContaining('Give a commit message') })
  expect((await hobwork([])).stdout).toContain('Usage: hobwork <command>')
})

// A real git client pushing and fetching through the workspace's internal
// handler, the way the VM's commit tool does.
async function clientRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hobwork-git-client-'))
  await git(['clone', '--quiet', '--branch', 'spools', repoPath(host, 'filament'), dir])
  writeFileSync(join(dir, 'pushed.txt'), 'pushed\n')
  await git(['add', '.'], { cwd: dir })
  await git(['commit', '--quiet', '-m', 'Pushed'], {
    cwd: dir,
    env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' },
  })
  return dir
}

function gitRemote(dir: string, args: string[], token = session.env.HOBWORK_SESSION, project = 'filament'): Promise<string> {
  return git(
    [
      '-c',
      `http.extraHeader=x-hobwork-session: ${token}`,
      ...args.map((arg) => arg.replace('REMOTE', `${internalUrl}/git/${project}.git`)),
    ],
    { cwd: dir },
  )
}

test('the git route takes pushes to the workspace branch only', async () => {
  const dir = await clientRepo()
  await gitRemote(dir, ['push', '--quiet', 'REMOTE', 'HEAD:refs/heads/spools'])
  const head = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim()
  expect((await git(['--git-dir', repoPath(host, 'filament'), 'rev-parse', 'spools'])).trim()).toBe(head)

  await expect(gitRemote(dir, ['push', 'REMOTE', 'HEAD:refs/heads/other'])).rejects.toThrow(/403/)
  await expect(gitRemote(dir, ['push', 'REMOTE', 'HEAD:refs/heads/main'])).rejects.toThrow(/403/)
  await expect(gitRemote(dir, ['push', 'REMOTE', ':refs/heads/spools'])).rejects.toThrow(/403/)
  await expect(gitRemote(dir, ['push', 'REMOTE', 'HEAD:refs/heads/spools', 'HEAD:refs/heads/other'])).rejects.toThrow(/403/)
  expect(await git(['--git-dir', repoPath(host, 'filament'), 'branch', '--list', 'other'])).toBe('')
})

test('the git route needs the session and the workspace hob, and serves fetches', async () => {
  const dir = await clientRepo()
  await expect(gitRemote(dir, ['push', 'REMOTE', 'HEAD:refs/heads/spools'], 'forged')).rejects.toThrow(/could not read Username/)
  await expect(
    gitRemote(dir, ['push', 'REMOTE', 'HEAD:refs/heads/spools'], session.env.HOBWORK_SESSION, 'sleep'),
  ).rejects.toThrow(/not found/)
  await gitRemote(dir, ['fetch', '--quiet', 'REMOTE', '+refs/heads/main:refs/remotes/origin/main'])
  expect((await git(['rev-parse', 'refs/remotes/origin/main'], { cwd: dir })).trim()).toMatch(/^[0-9a-f]{40}$/)
})

test('the git route streams chunked pushes into git', async () => {
  const dir = await clientRepo()
  // Incompressible, so the pack is larger than git's post buffer and goes chunked.
  writeFileSync(join(dir, 'large.bin'), randomBytes(4 * 1024 * 1024))
  await git(['add', '.'], { cwd: dir })
  await git(['commit', '--quiet', '-m', 'Large'], {
    cwd: dir,
    env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' },
  })
  await gitRemote(dir, ['-c', 'http.postBuffer=65536', 'push', '--quiet', 'REMOTE', 'HEAD:refs/heads/spools'])
  const head = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim()
  expect((await git(['--git-dir', repoPath(host, 'filament'), 'rev-parse', 'spools'])).trim()).toBe(head)
})

function pktLine(line: string): string {
  return `${(line.length + 4).toString(16).padStart(4, '0')}${line}`
}

test('push commands are checked however the body is split', () => {
  const body = Buffer.from(`${pktLine(`${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/spools\0report-status\n`)}0000PACK`)
  for (let end = 0; end < body.indexOf('0000PACK') + 4; end++) {
    expect(checkPushCommands(body.subarray(0, end), 'refs/heads/spools')).toBeUndefined()
  }
  expect(checkPushCommands(body, 'refs/heads/spools')).toEqual({})
  expect(checkPushCommands(body, 'refs/heads/other')).toEqual({ problem: 'This workspace can only push to refs/heads/other' })
  expect(checkPushCommands(Buffer.from('zzzz'), 'refs/heads/spools')).toEqual({ problem: 'Malformed push request' })
})

test('a refused push answers without reading the rest of the body', async () => {
  let canceled = false
  const commands = pktLine(`${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/other\n`)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(`${commands}0000PACK`))
    },
    cancel() {
      canceled = true
    },
  })
  const response = await handler(
    new Request('http://hobwork.internal/git/filament.git/git-receive-pack', {
      method: 'POST',
      headers: { 'x-hobwork-session': session.env.HOBWORK_SESSION ?? '' },
      body,
      duplex: 'half',
    }),
  )
  expect(response.status).toBe(403)
  expect(await response.text()).toContain('can only push to refs/heads/spools')
  expect(canceled).toBe(true)
})
