import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createAgentToken } from './agents.ts'
import { createApp } from './app.ts'
import { createDelivery } from './delivery.ts'
import { branchFileReader } from './files.ts'
import { pipelineVmBackend, workspaceVmBackend, type GuestVmOptions } from './guest-vm.ts'
import { createGondolinSandbox } from './sandbox/gondolin.ts'
import { imageDir, imageExists } from './sandbox/image.ts'
import { createTestHost } from './test-host.ts'
import { createWorkspaceApi } from './workspace-api.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from './workspaces.ts'

// Boots real VMs, so it only runs with HOBWORK_VM_TESTS=1 (`pnpm test:vm`).
describe.runIf(process.env.HOBWORK_VM_TESTS === '1')('workspace and pipeline VMs', { timeout: 300_000 }, () => {
  const vmOptions: GuestVmOptions = { image: imageDir(), createSandbox: createGondolinSandbox, readBranchFile: (workspace, path) => branchFileReader(host)(workspace, path) }
  const pipelineVms = pipelineVmBackend(vmOptions)
  let host: ReturnType<typeof createTestHost>
  let workspaces: ReturnType<typeof createWorkspaceManager<ExecWorkspaceVm>>
  let server: Server
  let client: Client

  beforeAll(async () => {
    if (!imageExists(vmOptions.image)) throw new Error(`no guest image at ${vmOptions.image}, run images/build.sh`)
    host = createTestHost()
    workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, { startVm: workspaceVmBackend(vmOptions, (workspace) => api(workspace)) })
    const delivery = createDelivery(host, { workspaces, pipeline: { startVm: pipelineVms.start } })
    const api = createWorkspaceApi({ host, workspaces, delivery })
    server = createApp(host, { workspaces, delivery })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
    const { token } = createAgentToken(host.db, 'claude')
    client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    )
  })

  afterAll(async () => {
    await client?.close()
    await workspaces?.stopAll()
    await pipelineVms.stopAll()
    if (server) await new Promise((resolve) => server.close(resolve))
    host?.dispose()
  })

  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as CallToolResult
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    return { text, isError: result.isError === true }
  }

  async function ok(name: string, args: Record<string, unknown>): Promise<string> {
    const { text, isError } = await call(name, args)
    expect(isError, text).toBe(false)
    return text
  }

  const p = { hob: 'filament', branch: 'greeting' }
  const checks = 'pnpm typecheck && pnpm lint && pnpm test && pnpm build'

  test('an agent checks, merges and breaks the template project', async () => {
    await ok('create_hob', { name: 'filament' })
    await ok('create_branch', p)

    const passing = await ok('bash', { ...p, command: checks, timeout_seconds: 300 })
    expect(passing, passing).toMatch(/^exit code: 0/)
    expect(passing).toContain('built in')

    await ok('write_file', { ...p, path: 'src/extra.ts', content: 'export const extra = 1\n' })
    await ok('commit', { ...p, message: 'Add extra' })
    const merged = await ok('merge', { ...p, summary: 'Add extra' })
    expect(merged, merged).toMatch(/^Merged greeting into main as version 2/)

    const greeting = await ok('read_file', { ...p, path: 'src/greeting.ts' })
    await ok('write_file', { ...p, path: 'src/greeting.ts', content: greeting.replace("'Good morning'", "'Hi'") })
    const failing = await ok('bash', { ...p, command: 'pnpm test', timeout_seconds: 300 })
    expect(failing).toMatch(/^exit code: 1/)
    expect(failing).toContain('greeting at 7:00')

    await ok('commit', { ...p, message: 'Say hi' })
    const { text, isError } = await call('merge', { ...p, summary: 'Say hi' })
    expect(isError, text).toBe(true)
    expect(text).toContain('the test step failed')
    expect(JSON.parse(await ok('list_versions', { hob: p.hob }))).toHaveLength(2)
  })

  test('installs are age-gated, blocked from running scripts and frozen in the pipeline', async () => {
    const extras = { hob: p.hob, branch: 'extras' }
    await ok('create_branch', extras)
    expect(await ok('bash', { ...extras, command: 'pnpm config get minimumReleaseAge' })).toContain('4320')

    const scripts = await ok('bash', { ...extras, command: 'pnpm add esbuild', timeout_seconds: 300 })
    expect(scripts).toContain('ERR_PNPM_IGNORED_BUILDS')
    await ok('bash', { ...extras, command: 'pnpm remove esbuild && rm -f pnpm-lock.yaml', timeout_seconds: 300 })

    const added = await ok('bash', { ...extras, command: 'pnpm add is-odd@3.0.1', timeout_seconds: 300 })
    expect(added, added).toMatch(/^exit code: 0/)
    await ok('commit', { ...extras, message: 'Add is-odd' })
    const merged = await ok('merge', { ...extras, summary: 'Add is-odd' })
    expect(merged, merged).toMatch(/^Merged extras into main/)

    await ok('create_branch', { ...extras, branch: 'no-lockfile' })
    const noLock = { ...extras, branch: 'no-lockfile' }
    await ok('bash', { ...noLock, command: 'rm pnpm-lock.yaml' })
    await ok('commit', { ...noLock, message: 'Drop lockfile' })
    const refused = await call('merge', { ...noLock, summary: 'Drop lockfile' })
    expect(refused.isError, refused.text).toBe(true)
    expect(refused.text).toContain('commit pnpm-lock.yaml')
  })

  test('file tools and commits run in the VM', async () => {
    const tools = { hob: p.hob, branch: 'tools' }
    await ok('create_branch', tools)
    await ok('bash', { ...tools, command: 'ln -s /etc etc-link && echo hi > made.txt' })
    const escape = await call('read_file', { ...tools, path: 'etc-link/passwd' })
    expect(escape.isError, escape.text).toBe(true)
    expect(escape.text).toContain('symlink')
    expect(await ok('read_file', { ...tools, path: 'made.txt' })).toBe('hi')
    expect(await ok('search', { ...tools, pattern: '^hi$' })).toBe('made.txt:1: hi')

    const commit = await ok('commit', { ...tools, message: 'Add made' })
    expect(commit).toMatch(/^Committed [0-9a-f]{40}$/)
    const [head] = JSON.parse(await ok('log', { hob: p.hob, ref: 'tools', limit: 1 }))
    expect(head).toMatchObject({ subject: 'Add made', author: 'claude', sha: commit.slice('Committed '.length) })
    expect(await ok('diff', tools)).toBe('No changes')
  })

  test('commands run unprivileged and cannot read session tokens, while the hobwork CLI still works', async () => {
    const priv = { hob: p.hob, branch: 'privilege' }
    await ok('create_branch', priv)
    const script = [
      'echo "uid=$(id -u)"',
      'echo "env-token=$(env | grep -c HOBWORK_SESSION)"',
      "echo \"proc-token=$(cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '^HOBWORK_SESSION=')\"",
      'echo "visible-processes=$(ls /proc | grep -c \'^[0-9]\')"',
      'echo "run-dir=$(ls /run/hobwork 2>&1 | head -1)"',
      'echo "ptrace-scope=$(cat /proc/sys/kernel/yama/ptrace_scope)"',
      'echo "proc-mount=$(grep \' /proc \' /proc/mounts)"',
      'echo "workspace-write=$(touch made-by-agent && echo ok)"',
      'echo "owner=$(stat -c %U made-by-agent)"',
      'echo "sudo=$(doas /bin/sh -c id 2>&1 | head -1)"',
    ].join('\n')
    const out = await ok('bash', { ...priv, command: script })
    expect(out).toContain('uid=1000')
    expect(out).toContain('env-token=0')
    expect(out).toContain('proc-token=0')
    expect(out).toMatch(/visible-processes=([1-9]|1\d)\n/)
    expect(out).toMatch(/run-dir=ls: .*Permission denied/)
    expect(out).toContain('ptrace-scope=1')
    expect(out).toMatch(/proc-mount=.*hidepid=(2|invisible)/)
    expect(out).toContain('workspace-write=ok')
    expect(out).toContain('owner=agent')
    expect(out).not.toContain('uid=0')
    expect(out).toContain('sudo=doas: ')

    const status = await ok('bash', { ...priv, command: 'hobwork status' })
    expect(status, status).toMatch(/^exit code: 0/)
    expect(status).toContain('privilege')

    // A process that outlives its command has no session to act for.
    await ok('bash', {
      ...priv,
      command: "nohup sh -c 'sleep 4; hobwork status > /tmp/late.out 2>&1' > /dev/null 2>&1 &",
    })
    const late = await ok('bash', { ...priv, command: 'sleep 8; cat /tmp/late.out' })
    expect(late).toContain('only works in commands started over SSH or with the bash tool')
    expect(late).not.toContain('privilege')

    await ok('write_file', { ...priv, path: 'src/privilege.ts', content: 'export const privilege = 1\n' })
    const commit = await ok('bash', { ...priv, command: 'hobwork commit "Add privilege"' })
    expect(commit, commit).toMatch(/^exit code: 0/)
    const merged = await ok('bash', { ...priv, command: 'hobwork merge "Add privilege"', timeout_seconds: 300 })
    expect(merged, merged).toMatch(/Merged privilege into main/)
  })

  test('egress follows the committed hobwork.json and the VM restarts when it changes', async () => {
    const status = 'curl -s -o /dev/null -w "%{http_code}" https://example.com/'
    expect(await ok('bash', { ...p, command: status })).toContain('403')
    const config = JSON.parse(await ok('read_file', { ...p, path: 'hobwork.json' }))
    await ok('write_file', { ...p, path: 'hobwork.json', content: JSON.stringify({ ...config, egress: ['example.com'] }) })
    expect(await ok('bash', { ...p, command: status })).toContain('403')
    await ok('commit', { ...p, message: 'Allow example.com' })
    expect(await ok('bash', { ...p, command: status })).toContain('200')
  })

  test('idle workspace VMs stop', async () => {
    const idle = createWorkspaceManager<ExecWorkspaceVm>(host, {
      startVm: workspaceVmBackend(vmOptions),
      idleTimeoutMs: 1000,
    })
    await ok('create_branch', { ...p, branch: 'idle' })
    const vm = await idle.start(p.hob, 'idle')
    expect((await vm.exec('echo up', { cwd: '.', timeoutMs: 10_000 })).stdout).toBe('up\n')
    expect(idle.get(p.hob, 'idle')?.status).toBe('running')
    await vi.waitFor(() => expect(idle.get(p.hob, 'idle')?.status).toBe('stopped'), { timeout: 10_000, interval: 200 })
    await expect(vm.exec('true', { cwd: '.', timeoutMs: 5000 })).rejects.toThrow()
  })
})
