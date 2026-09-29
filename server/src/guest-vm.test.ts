import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { pipelineVmBackend, workspaceVmBackend } from './guest-vm.ts'
import type { ExecOptions, Sandbox, SandboxOptions, SpawnOptions } from './sandbox/sandbox.ts'
import type { Workspace } from './workspaces.ts'

type FakeSandbox = Sandbox & {
  options: SandboxOptions
  commands: { command: string; options: ExecOptions | SpawnOptions }[]
  stopped: boolean
  // Ends the process started last with spawn.
  exit?: (result: { exitCode: number; signal?: number }) => void
}

let dir: string
let sandboxes: FakeSandbox[]

async function createSandbox(options: SandboxOptions): Promise<FakeSandbox> {
  const sandbox: FakeSandbox = {
    id: String(sandboxes.length),
    options,
    commands: [],
    stopped: false,
    exec(command, execOptions = {}) {
      sandbox.commands.push({ command, options: execOptions })
      execOptions.onOutput?.({ stream: 'stdout', text: `ran ${command}\n` })
      execOptions.onOutput?.({ stream: 'stderr', text: 'warning\n' })
      const exitCode = command === 'false' ? 1 : 0
      return {
        result: Promise.resolve({ exitCode, timedOut: false, killed: false, stdout: '', stderr: '' }),
        kill: async () => {},
      }
    },
    spawn(command, spawnOptions) {
      sandbox.commands.push({ command, options: spawnOptions })
      const input: string[] = []
      const result = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
        sandbox.exit = resolve
      })
      return {
        result,
        write: (data) => void input.push(Buffer.from(data).toString()),
        end: () => spawnOptions.onData('stdout', Buffer.from(input.join(''))),
        resize: () => {},
        kill: async () => {},
      }
    },
    ingress: async () => '',
    readFile: async () => Buffer.from(''),
    writeFile: async () => {},
    hostPid: () => null,
    async stop() {
      sandbox.stopped = true
    },
  }
  sandboxes.push(sandbox)
  return sandbox
}

function workspace(): Workspace {
  return {
    id: 1,
    project: 'filament',
    branch: 'spools',
    status: 'starting',
    dir,
    createdAt: '',
    lastUsedAt: '',
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobwork-guest-vm-test-'))
  sandboxes = []
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('workspace VMs mount the checkout with node_modules on the VM disk', async () => {
  writeFileSync(join(dir, 'hobwork.json'), JSON.stringify({ egress: ['api.example.com'] }))
  const vm = await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  const [sandbox] = sandboxes
  expect(sandbox?.options).toMatchObject({
    image: '/image',
    cpus: 4,
    memory: '2G',
    mounts: { '/workspace': { hostPath: dir, vmDisk: ['node_modules'] } },
    egress: ['registry.npmjs.org', 'api.example.com'],
  })
  expect(vm.egress).toEqual(['registry.npmjs.org', 'api.example.com'])
  expect(sandbox?.options.mounts?.['/opt/hobwork/cli']).toMatchObject({ readonly: true })
  // Only the CLI is installed: there are no extras.
  expect(sandbox?.commands.map((c) => c.command)).toEqual([expect.stringContaining('/usr/local/bin/hobwork')])

  await vm.stop()
  expect(sandbox?.stopped).toBe(true)
})

test('exec maps cwd into the guest and returns streamed output', async () => {
  const vm = await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  const chunks: string[] = []
  const result = await vm.exec('pnpm test', {
    cwd: 'src/lib',
    timeoutMs: 1000,
    onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`),
  })
  expect(result).toEqual({ exitCode: 0, stdout: 'ran pnpm test\n', stderr: 'warning\n' })
  expect(chunks).toEqual(['stdout:ran pnpm test\n', 'stderr:warning\n'])
  expect(sandboxes[0]?.commands[1]?.options).toMatchObject({ cwd: '/workspace/src/lib', timeoutMs: 1000 })

  await vm.exec('true', { cwd: '.', timeoutMs: 1000 })
  expect(sandboxes[0]?.commands[2]?.options.cwd).toBe('/workspace')
  await expect(vm.exec('true', { cwd: '../etc', timeoutMs: 1000 })).rejects.toThrow('outside')
})

test('installs extras on start', async () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19.3.0', 'left-pad': '1.3.0' } }))
  await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  expect(sandboxes[0]?.commands.slice(1).map((c) => [c.command, c.options.cwd])).toEqual([['pnpm install', '/workspace']])
})

test('platform packages alone are not installed', async () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19.3.0', '@hobwork/sdk': '0.0.0' } }))
  await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  expect(sandboxes[0]?.commands).toHaveLength(1)
})

test('spawned processes keep the VM busy and report signals as exit codes', async () => {
  const vm = await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  const output: string[] = []
  const proc = vm.spawn('bash', {
    cwd: '.',
    env: { TERM: 'xterm' },
    pty: { rows: 24, cols: 80 },
    onData: (stream, data) => output.push(`${stream}:${data}`),
  })
  expect(sandboxes[0]?.commands[1]?.options).toMatchObject({ cwd: '/workspace', env: { TERM: 'xterm' }, pty: { rows: 24, cols: 80 } })
  expect(vm.busy?.()).toBe(true)
  proc.write('echo hi\n')
  proc.end()
  expect(output).toEqual(['stdout:echo hi\n'])
  sandboxes[0]?.exit?.({ exitCode: 0, signal: 15 })
  expect(await proc.result).toEqual({ exitCode: 143 })
  expect(vm.busy?.()).toBe(false)
  expect(() => vm.spawn('true', { cwd: '..', onData: () => {} })).toThrow('outside')
})

test('the internal handler is bound to the workspace', async () => {
  const seen: string[] = []
  await workspaceVmBackend({ image: '/image', createSandbox }, (w) => {
    seen.push(`${w.project}/${w.branch}`)
    return () => new Response('ok')
  })(workspace())
  expect(seen).toEqual(['filament/spools'])
  expect(sandboxes[0]?.options.internal).toBeTypeOf('function')
})

test('a workspace VM is stale once the egress allowlist changes', async () => {
  const vm = await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  expect(vm.isStale?.()).toBe(false)
  writeFileSync(join(dir, 'hobwork.json'), JSON.stringify({ egress: ['api.example.com'] }))
  expect(vm.isStale?.()).toBe(true)
  writeFileSync(join(dir, 'hobwork.json'), '{ not json')
  expect(vm.isStale?.()).toBe(false)
})

test('pipeline VMs only reach the registry and are stopped on shutdown', async () => {
  writeFileSync(join(dir, 'hobwork.json'), JSON.stringify({ egress: ['api.example.com'] }))
  const backend = pipelineVmBackend({ image: '/image', createSandbox })
  const first = await backend.start({ dir })
  await backend.start({ dir })
  expect(sandboxes[0]?.options.egress).toEqual(['registry.npmjs.org'])
  expect(sandboxes[0]?.options.cpus).toBe(4)

  expect(await first.exec('false', { cwd: '.', timeoutMs: 1000 })).toMatchObject({ exitCode: 1 })
  await first.stop()
  await backend.stopAll()
  expect(sandboxes.map((s) => s.stopped)).toEqual([true, true])
})
