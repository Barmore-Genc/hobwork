import { basename, join, posix, resolve } from 'node:path'
import { readRegularFile } from './files.ts'
import { parseHobworkJson } from '../../packages/sdk/src/hobwork-json.js'
import type { StartPipelineVm } from './pipeline/runner.ts'
import { extraDependencies } from './platform.ts'
import type { EgressBlocked, Interceptor, InternalHandler, Sandbox, SandboxFactory, SandboxOptions, Secret } from './sandbox/sandbox.ts'
import type {
  ExecOptions,
  ExecResult,
  InteractiveWorkspaceVm,
  StartWorkspaceVm,
  Workspace,
} from './workspaces.ts'
import { SESSION_HEADER } from './workspaces.ts'

export const GUEST_DIR = '/workspace'
export const NPM_REGISTRY = 'registry.npmjs.org'

// The `hobwork` CLI is mounted from the host, like the runtime runner, because
// it speaks the host's internal API and has to match the host version.
const CLI_DIR = '/opt/hobwork/cli'
const HOST_CLI_DIR = resolve(import.meta.dirname, '../../packages/sdk/src/cli')
// The icon renderer (packages/sdk/src/icons/main.ts) is host code too: it
// writes the files the host serves. sharp, Twemoji and the font come with the image.
const ICONS_DIR = '/opt/hobwork/icons'
const HOST_ICONS_DIR = resolve(import.meta.dirname, '../../packages/sdk/src/icons')

const INSTALL_CLI = [
  `printf '#!/bin/sh\\nexec node --disable-warning=ExperimentalWarning ${CLI_DIR}/main.ts "$@"\\n' > /usr/local/bin/hobwork`,
  'chmod 755 /usr/local/bin/hobwork',
].join(' && ')

// Answered by the workspace environment (the branch DB and Home Assistant);
// everything else on hobwork.internal goes to the CLI API.
export const ENVIRONMENT_PATHS = new Set(['/v1/db', '/v1/ha', '/v1/devices'])

const VM_RESOURCES = { memory: '2G', cpus: 4, diskSize: '4G' }
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

// What a workspace VM gets from the rest of the host: secrets, their hosts,
// and the internal endpoint with the branch DB.
export type VmEnvironment = {
  egress: string[]
  secrets: Record<string, Secret>
  internal?: InternalHandler
  intercept?: Interceptor
  onEgressBlocked?: (event: EgressBlocked) => void
}

export type WorkspaceEnvironment = {
  // Called while a workspace VM starts.
  start(workspace: Workspace): Promise<VmEnvironment>
  // Changes when start() would return different secrets or hosts, so the VM is replaced.
  fingerprint(workspace: Workspace): string
  stop?(workspace: Workspace): Promise<void>
}

export type GuestVmOptions = {
  image: string
  createSandbox: SandboxFactory
  log?: (message: string) => void
  workspaceEnvironment?: WorkspaceEnvironment
}

export type GuestWorkspaceVm = InteractiveWorkspaceVm & {
  egress: string[]
}

function guestCwd(cwd: string): string {
  const path = posix.join(GUEST_DIR, cwd)
  if (path !== GUEST_DIR && !path.startsWith(`${GUEST_DIR}/`)) throw new Error(`cwd "${cwd}" is outside the checkout`)
  return path
}

async function readJson(path: string, parse: (text: string) => unknown = JSON.parse): Promise<unknown> {
  try {
    return parse(await readRegularFile(path, basename(path)))
  } catch {
    return undefined
  }
}

// Invalid files count as empty. The pipeline reports them, and the agent can
// still run commands to fix them.
export async function hobworkEgress(dir: string): Promise<string[]> {
  const config = await readJson(join(dir, 'hobwork.json'), parseHobworkJson)
  const egress = (config as { egress?: unknown } | undefined)?.egress
  return Array.isArray(egress) ? egress.filter((host): host is string => typeof host === 'string') : []
}

export async function hasExtraDependencies(dir: string): Promise<boolean> {
  const pkg = await readJson(join(dir, 'package.json'))
  return typeof pkg === 'object' && pkg !== null && extraDependencies(pkg).length > 0
}

// `dir` is mounted read-write at /workspace. node_modules lives on the VM disk:
// the filesystem bridge is slow for many small files, and it only holds extras.
function sandboxOptions(
  options: GuestVmOptions,
  dir: string,
  egress: string[],
  label: string,
  environment?: VmEnvironment,
): SandboxOptions {
  return {
    image: options.image,
    ...VM_RESOURCES,
    mounts: { [GUEST_DIR]: { hostPath: dir, vmDisk: ['node_modules'] } },
    // Without a TTY, pnpm refuses to recreate node_modules unless it runs in CI mode.
    env: { CI: 'true' },
    egress,
    label,
    secrets: environment?.secrets,
    internal: environment?.internal,
    intercept: environment?.intercept,
    onEgressBlocked: (event) => {
      options.log?.(`${label}: blocked egress to ${event.hostname || event.ip}`)
      environment?.onEgressBlocked?.(event)
    },
  }
}

function exitCode(result: { exitCode: number; signal?: number }): number {
  return result.signal === undefined ? result.exitCode : 128 + result.signal
}

function execVm(sandbox: Sandbox): Omit<InteractiveWorkspaceVm, 'stop'> & { busy(): boolean } {
  let running = 0
  return {
    busy: () => running > 0,
    async exec(command: string, { cwd, timeoutMs, signal, env, onOutput }: ExecOptions): Promise<ExecResult> {
      const output = { stdout: '', stderr: '' }
      running++
      try {
        const result = await sandbox.exec(command, {
          cwd: guestCwd(cwd),
          timeoutMs,
          signal,
          env,
          onOutput: ({ stream, text }) => {
            output[stream] += text
            onOutput?.(stream, text)
          },
        }).result
        return { exitCode: exitCode(result), ...output }
      } finally {
        running--
      }
    },
    spawn(command, { cwd, env, pty, onData }) {
      const proc = sandbox.spawn(command, { cwd: guestCwd(cwd), env, pty, onData })
      running++
      const result = proc.result
        .then((r) => ({ exitCode: exitCode(r) }))
        .finally(() => {
          running--
        })
      return { ...proc, result }
    },
  }
}

// `internal` answers the VM's calls to hobwork.internal (the `hobwork` CLI).
// `hasSession` says whether a token belongs to a running command in the
// workspace; the DB, Home Assistant and device routes refuse calls without one.
export function workspaceVmBackend(
  options: GuestVmOptions,
  internal?: (workspace: Workspace) => InternalHandler,
  hasSession?: (workspace: Workspace, token: string) => boolean,
): StartWorkspaceVm<GuestWorkspaceVm> {
  return async (workspace) => {
    const label = `workspace ${workspace.project}/${workspace.branch}`
    const environments = options.workspaceEnvironment
    const fingerprint = environments?.fingerprint(workspace) ?? ''
    const environment = await environments?.start(workspace)
    // The registry is always reachable so agents can add and install extras.
    const egress = [...new Set([NPM_REGISTRY, ...(await hobworkEgress(workspace.dir)), ...(environment?.egress ?? [])])]
    const base = sandboxOptions(options, workspace.dir, egress, label, environment)
    const cliApi = internal?.(workspace)
    const environmentApi = environment?.internal
    let sandbox: Sandbox
    try {
      sandbox = await options.createSandbox({
        ...base,
        mounts: { ...base.mounts, [CLI_DIR]: { hostPath: HOST_CLI_DIR, readonly: true } },
        internal: (request) => {
          if (ENVIRONMENT_PATHS.has(new URL(request.url).pathname)) {
            if (!hasSession?.(workspace, request.headers.get(SESSION_HEADER) ?? '')) {
              return Response.json(
                { error: 'This only works in commands started over SSH or with the bash tool, which set HOBWORK_SESSION' },
                { status: 401 },
              )
            }
            if (environmentApi) return environmentApi(request)
          }
          return cliApi?.(request) ?? Response.json({ error: 'not found' }, { status: 404 })
        },
      })
    } catch (err) {
      await environments?.stop?.(workspace)
      throw err
    }
    const cli = await sandbox.exec(INSTALL_CLI).result.catch((err: unknown) => err as Error)
    if (cli instanceof Error || cli.exitCode !== 0) {
      await sandbox.stop()
      await environments?.stop?.(workspace)
      throw new Error(`Could not install the hobwork CLI in ${label}: ${cli instanceof Error ? cli.message : cli.stderr}`)
    }
    const vm = execVm(sandbox)

    if (await hasExtraDependencies(workspace.dir)) {
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
      stop: async () => {
        await sandbox.stop()
        await environments?.stop?.(workspace)
      },
      isStale: async () => {
        if ((environments?.fingerprint(workspace) ?? '') !== fingerprint) return true
        const current = new Set([NPM_REGISTRY, ...(await hobworkEgress(workspace.dir)), ...(environment?.egress ?? [])])
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
      const base = sandboxOptions(options, dir, [NPM_REGISTRY], 'pipeline')
      const sandbox = await options.createSandbox({
        ...base,
        mounts: { ...base.mounts, [ICONS_DIR]: { hostPath: HOST_ICONS_DIR, readonly: true } },
      })
      running.add(sandbox)
      return {
        ...execVm(sandbox),
        iconsCommand: `node ${ICONS_DIR}/main.ts`,
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
