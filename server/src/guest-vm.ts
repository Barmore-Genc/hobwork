import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { StartPipelineVm } from './pipeline/runner.ts'
import { extraDependencies } from './platform.ts'
import type { Sandbox, SandboxFactory, SandboxOptions } from './sandbox/sandbox.ts'
import type { ExecOptions, ExecResult, ExecWorkspaceVm, StartWorkspaceVm } from './workspaces.ts'

export const GUEST_DIR = '/workspace'
export const NPM_REGISTRY = 'registry.npmjs.org'

const VM_RESOURCES = { memory: '2G', cpus: 4, diskSize: '4G' }
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

export type GuestVmOptions = {
  image: string
  createSandbox: SandboxFactory
  log?: (message: string) => void
}

export type GuestWorkspaceVm = ExecWorkspaceVm & {
  egress: string[]
}

function guestCwd(cwd: string): string {
  const path = posix.join(GUEST_DIR, cwd)
  if (path !== GUEST_DIR && !path.startsWith(`${GUEST_DIR}/`)) throw new Error(`cwd "${cwd}" is outside the checkout`)
  return path
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// Invalid files count as empty. The pipeline reports them, and the agent can
// still run commands to fix them.
export function hobworkEgress(dir: string): string[] {
  const config = readJson(join(dir, 'hobwork.json'))
  const egress = (config as { egress?: unknown } | undefined)?.egress
  return Array.isArray(egress) ? egress.filter((host): host is string => typeof host === 'string') : []
}

export function hasExtraDependencies(dir: string): boolean {
  const pkg = readJson(join(dir, 'package.json'))
  return typeof pkg === 'object' && pkg !== null && extraDependencies(pkg).length > 0
}

// `dir` is mounted read-write at /workspace. node_modules lives on the VM disk:
// the filesystem bridge is slow for many small files, and it only holds extras.
function sandboxOptions(options: GuestVmOptions, dir: string, egress: string[], label: string): SandboxOptions {
  return {
    image: options.image,
    ...VM_RESOURCES,
    mounts: { [GUEST_DIR]: { hostPath: dir, vmDisk: ['node_modules'] } },
    // Without a TTY, pnpm refuses to recreate node_modules unless it runs in CI mode.
    env: { CI: 'true' },
    egress,
    label,
    onEgressBlocked: ({ hostname }) => options.log?.(`${label}: blocked egress to ${hostname}`),
  }
}

function execVm(sandbox: Sandbox): Omit<ExecWorkspaceVm, 'stop'> & { busy(): boolean } {
  let running = 0
  return {
    busy: () => running > 0,
    async exec(command: string, { cwd, timeoutMs, signal, onOutput }: ExecOptions): Promise<ExecResult> {
      const output = { stdout: '', stderr: '' }
      running++
      try {
        const result = await sandbox.exec(command, {
          cwd: guestCwd(cwd),
          timeoutMs,
          signal,
          onOutput: ({ stream, text }) => {
            output[stream] += text
            onOutput?.(stream, text)
          },
        }).result
        const exitCode = result.signal === undefined ? result.exitCode : 128 + result.signal
        return { exitCode, ...output }
      } finally {
        running--
      }
    },
  }
}

export function workspaceVmBackend(options: GuestVmOptions): StartWorkspaceVm<GuestWorkspaceVm> {
  return async (workspace) => {
    const label = `workspace ${workspace.project}/${workspace.branch}`
    // The registry is always reachable so agents can add and install extras.
    const egress = [...new Set([NPM_REGISTRY, ...hobworkEgress(workspace.dir)])]
    const sandbox = await options.createSandbox(sandboxOptions(options, workspace.dir, egress, label))
    const vm = execVm(sandbox)

    if (hasExtraDependencies(workspace.dir)) {
      // A failed install does not fail the start: the agent sees missing
      // packages and can run pnpm install itself to get the error.
      const install = await vm.exec('pnpm install', { cwd: '.', timeoutMs: INSTALL_TIMEOUT_MS })
      if (install.exitCode !== 0) {
        options.log?.(`${label}: pnpm install failed with exit code ${install.exitCode}\n${install.stderr}`)
      }
    }

    return {
      ...vm,
      egress,
      stop: () => sandbox.stop(),
      isStale: () => {
        const current = new Set([NPM_REGISTRY, ...hobworkEgress(workspace.dir)])
        return current.size !== egress.length || egress.some((host) => !current.has(host))
      },
    }
  }
}

// Only the registry: the pipeline installs extras but never runs project code
// that needs the network.
export function pipelineVmBackend(options: GuestVmOptions): { start: StartPipelineVm; stopAll(): Promise<void> } {
  const running = new Set<Sandbox>()
  return {
    async start({ dir }) {
      const sandbox = await options.createSandbox(sandboxOptions(options, dir, [NPM_REGISTRY], 'pipeline'))
      running.add(sandbox)
      return {
        ...execVm(sandbox),
        stop: async () => {
          running.delete(sandbox)
          await sandbox.stop()
        },
      }
    },
    async stopAll() {
      const all = [...running]
      running.clear()
      await Promise.all(all.map((sandbox) => sandbox.stop()))
    },
  }
}
