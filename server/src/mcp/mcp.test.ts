import { spawn } from 'node:child_process'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createApp } from '../app.ts'
import { createTestHost } from '../test-host.ts'
import {
  createWorkspaceManager,
  type ExecWorkspaceVm,
  type Workspace,
  type WorkspaceManager,
} from '../workspaces.ts'

// Several tests run git and the MCP client end to end, which is slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>
let server: Server
let url: URL
let token: string
let client: Client
let vmStarts: Workspace[]
let workspaces: WorkspaceManager<ExecWorkspaceVm>

// Runs commands on the host in the workspace directory, standing in for a VM.
function fakeVm(workspace: Workspace): ExecWorkspaceVm {
  return {
    async stop() {},
    exec(command, { cwd, signal, env, onOutput }) {
      return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', command], { cwd: join(workspace.dir, cwd), signal, env: { ...process.env, ...env } })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk
          onOutput?.('stdout', chunk.toString())
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk
          onOutput?.('stderr', chunk.toString())
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
      })
    },
  }
}

async function listen(withVms: boolean): Promise<void> {
  workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, {
    startVm: withVms
      ? async (workspace) => {
          vmStarts.push(workspace)
          return fakeVm(workspace)
        }
      : undefined,
  })
  server = createApp(host, { workspaces })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
}

async function connect(authToken = token): Promise<Client> {
  const connected = new Client({ name: 'test', version: '0.0.0' })
  await connected.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${authToken}` } },
    }),
  )
  return connected
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await call(name, args)
  expect(result.isError, textOf(result)).toBeFalsy()
  return textOf(result)
}

async function fails(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(name, args)
  expect(result.isError, textOf(result)).toBe(true)
  return textOf(result)
}

beforeEach(async () => {
  host = createTestHost()
  token = createAgentToken(host.db, 'claude').token
  vmStarts = []
  await listen(true)
  client = await connect()
})

afterEach(async () => {
  await client.close()
  await new Promise((resolve) => server.close(resolve))
  host.dispose()
})

test('rejects requests without a valid agent token', async () => {
  const noAuth = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(noAuth.status).toBe(401)
  expect(noAuth.headers.get('www-authenticate')).toContain('Bearer')
  await expect(connect('hw_wrong')).rejects.toThrow()
})

test('lists tools and sends instructions pointing at AGENTS.md', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      'assign_secret',
      'bash',
      'commit',
      'create_branch',
      'create_project',
      'delete_file',
      'diff',
      'edit_file',
      'get_logs',
      'get_project',
      'invoke',
      'list_branches',
      'list_devices',
      'list_files',
      'list_invocations',
      'list_projects',
      'list_secrets',
      'list_versions',
      'log',
      'merge',
      'pipeline_status',
      'read_file',
      'restore_version',
      'rotate_webhook_token',
      'search',
      'tail_logs',
      'unassign_secret',
      'write_file',
    ].sort(),
  )
  expect(client.getInstructions()).toContain('AGENTS.md')
})

test('creates a project, edits files on a branch and commits as the agent', async () => {
  await ok('create_project', { name: 'filament' })
  expect(JSON.parse(await ok('list_projects'))).toMatchObject([{ name: 'filament' }])
  const project = JSON.parse(await ok('get_project', { project: 'filament' }))
  expect(project.entryPoints.routes).toHaveProperty(['GET /greeting'])
  expect(project.entryPoints.crons).toHaveProperty('morning-greeting')
  expect(project.appUrl).toBe('http://filament.apps.localhost')

  expect(await ok('read_file', { project: 'filament', branch: 'main', path: 'AGENTS.md' })).toContain(
    'Hobwork project',
  )
  await ok('create_branch', { project: 'filament', branch: 'spools' })
  const branches = JSON.parse(await ok('list_branches', { project: 'filament' }))
  expect(branches.map((b: { name: string; appUrl: string }) => [b.name, b.appUrl])).toEqual([
    ['main', 'http://filament.apps.localhost'],
    ['spools', 'http://spools--filament.apps.localhost'],
  ])

  const b = { project: 'filament', branch: 'spools' }
  expect(await ok('write_file', { ...b, path: 'src/spools.ts', content: 'export const spools = []\n' })).toBe(
    'Created src/spools.ts',
  )
  await ok('edit_file', { ...b, path: 'src/spools.ts', old_string: '[]', new_string: "['pla']" })
  expect(await ok('read_file', { ...b, path: 'src/spools.ts' })).toBe("export const spools = ['pla']")
  expect(await ok('list_files', { ...b, path: 'src' })).toContain('src/spools.ts')
  expect(await ok('search', { ...b, pattern: "spools = \\['pla", glob: '*.ts' })).toBe(
    "src/spools.ts:1: export const spools = ['pla']",
  )
  await ok('delete_file', { ...b, path: 'src/greeting-route.ts' })
  expect(await ok('list_files', { ...b, path: 'src' })).not.toContain('greeting-route')

  const uncommitted = await ok('diff', b)
  expect(uncommitted).toContain("+export const spools = ['pla']")
  expect(uncommitted).toContain('deleted file mode')

  expect(await ok('commit', { ...b, message: 'Add spools' })).toMatch(/^Committed [0-9a-f]{40}$/)
  expect(await ok('commit', { ...b, message: 'Again' })).toBe('Nothing to commit')
  expect(await ok('diff', b)).toBe('No changes')
  expect(await ok('diff', { ...b, scope: 'branch' })).toContain('src/spools.ts')

  const commits = JSON.parse(await ok('log', { project: 'filament', ref: 'spools' }))
  expect(commits[0]).toMatchObject({ subject: 'Add spools', author: 'claude' })

  // main is unchanged and still readable.
  await fails('read_file', { project: 'filament', branch: 'main', path: 'src/spools.ts' })
})

test('refuses changes on main', async () => {
  await ok('create_project', { name: 'filament' })
  const main = { project: 'filament', branch: 'main' }
  expect(await fails('write_file', { ...main, path: 'x.ts', content: '' })).toContain('create_branch')
  await fails('edit_file', { ...main, path: 'AGENTS.md', old_string: 'Hobwork', new_string: 'X' })
  await fails('delete_file', { ...main, path: 'AGENTS.md' })
  await fails('commit', { ...main, message: 'x' })
  await fails('bash', { ...main, command: 'true' })
})

test('rejects paths outside the checkout', async () => {
  await ok('create_project', { name: 'filament' })
  await ok('create_branch', { project: 'filament', branch: 'spools' })
  const b = { project: 'filament', branch: 'spools' }
  expect(await fails('read_file', { ...b, path: '../../../hobwork.db' })).toContain('outside the project')
  expect(await fails('write_file', { ...b, path: '../main/files/x', content: '' })).toContain(
    'outside the project',
  )
  expect(await fails('read_file', { ...b, path: '/etc/passwd' })).toContain('relative')
  await fails('list_files', { ...b, path: '..' })
  await fails('search', { ...b, pattern: 'x', path: '../..' })
  await fails('bash', { ...b, command: 'true', cwd: '..' })
})

test('reports unknown projects and branches as tool errors', async () => {
  expect(await fails('get_project', { project: 'nope' })).toContain('does not exist')
  await ok('create_project', { name: 'filament' })
  expect(await fails('read_file', { project: 'filament', branch: 'nope', path: 'x' })).toContain(
    'does not exist',
  )
})

test('bash runs in the branch workspace VM', async () => {
  await ok('create_project', { name: 'filament' })
  await ok('create_branch', { project: 'filament', branch: 'spools' })
  const b = { project: 'filament', branch: 'spools' }

  const out = await ok('bash', { ...b, command: 'echo made > made.txt && ls && echo oops >&2' })
  expect(out).toMatch(/^exit code: 0/)
  expect(out).toContain('AGENTS.md')
  expect(out).toContain('--- stderr ---\noops')
  expect(await ok('read_file', { ...b, path: 'made.txt' })).toBe('made')
  expect(await ok('bash', { ...b, command: 'pwd', cwd: 'src' })).toMatch(/src\n?$/)
  expect(await ok('bash', { ...b, command: 'exit 3' })).toBe('exit code: 3')
  expect(vmStarts).toHaveLength(1)

  // The hobwork CLI in the VM acts as the agent that called bash, while the command runs.
  const session = (await ok('bash', { ...b, command: 'echo "$HOBWORK_SESSION"' })).trim().split('\n').at(-1) ?? ''
  expect(session).toMatch(/^[\w-]{43}$/)
  expect(workspaces.sessionAgent('filament', 'spools', session)).toBeUndefined()

  const long = await ok('bash', { ...b, command: 'head -c 100000 /dev/zero | tr "\\0" x' })
  expect(long).toContain('characters omitted')
  expect(long.length).toBeLessThan(40_000)
})

test('bash stops commands at the timeout', async () => {
  await ok('create_project', { name: 'filament' })
  await ok('create_branch', { project: 'filament', branch: 'spools' })
  const out = await fails('bash', {
    project: 'filament',
    branch: 'spools',
    command: 'echo started; sleep 10',
    timeout_seconds: 1,
  })
  expect(out).toContain('timed out after 1s')
  expect(out).toContain('started')
})

test('bash without a VM backend returns a tool error', async () => {
  await client.close()
  await new Promise((resolve) => server.close(resolve))
  await listen(false)
  client = await connect()
  await ok('create_project', { name: 'filament' })
  await ok('create_branch', { project: 'filament', branch: 'spools' })
  expect(await fails('bash', { project: 'filament', branch: 'spools', command: 'ls' })).toContain(
    'no workspace VM backend',
  )
})
