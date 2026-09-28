import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { pipelineVmBackend, workspaceVmBackend } from './guest-vm.ts'
import type { ExecOptions, Sandbox, SandboxOptions } from './sandbox/sandbox.ts'
import type { Workspace } from './workspaces.ts'

type FakeSandbox = Sandbox & { options: SandboxOptions; commands: { command: string; options: ExecOptions }[]; stopped: boolean }

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
  // No extras, so nothing is installed.
  expect(sandbox?.commands).toEqual([])

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
  expect(sandboxes[0]?.commands[0]?.options).toMatchObject({ cwd: '/workspace/src/lib', timeoutMs: 1000 })

  await vm.exec('true', { cwd: '.', timeoutMs: 1000 })
  expect(sandboxes[0]?.commands[1]?.options.cwd).toBe('/workspace')
  await expect(vm.exec('true', { cwd: '../etc', timeoutMs: 1000 })).rejects.toThrow('outside')
})

test('installs extras on start', async () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19.3.0', 'left-pad': '1.3.0' } }))
  await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  expect(sandboxes[0]?.commands.map((c) => [c.command, c.options.cwd])).toEqual([['pnpm install', '/workspace']])
})

test('platform packages alone are not installed', async () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19.3.0', '@hobwork/sdk': '0.0.0' } }))
  await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  expect(sandboxes[0]?.commands).toEqual([])
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
