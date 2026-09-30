import { join, posix, resolve } from 'node:path'
import { readRegularFile } from './files.ts'
import { parseHobworkJson } from '../../packages/sdk/src/hobwork-json.js'
import { HeadTailOutput } from './mcp/output.ts'
import { MIN_RELEASE_AGE_MINUTES } from './pipeline/pnpm-settings.ts'
import type { StartPipelineVm } from './pipeline/runner.ts'
import { DEFAULT_RESOURCES, memorySize, resolveResources, type ResourceKind, type ResourceRequest } from './sandbox/budget.ts'
import { extraDependencies } from './platform.ts'
import {
  GUEST_GID,
  GUEST_UID,
  type EgressBlocked,
  type Interceptor,
  type InternalHandler,
  type Sandbox,
  type SandboxFactory,
  type SandboxOptions,
  type SecretRefused,
  type Secret,
  type VmKind,
} from './sandbox/sandbox.ts'
import type {
  ExecOptions,
  ExecResult,
  ExecWorkspaceVm,
  InteractiveWorkspaceVm,
  StartWorkspaceVm,
  Workspace,
} from './workspaces.ts'
import { SESSION_HEADER } from './workspaces.ts'
import { streamsWorkspaceGitBody } from './workspace-git.ts'
import { TOOL_COMMAND } from './workspace-tools.ts'

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

// The file and git tools the host runs in the VM (see workspace-tools.ts). The
// checkout's git directory is mounted next to it, since the host never runs git
// on files the VM can write.
const TOOLS_DIR = '/opt/hobwork/tools'
const HOST_TOOLS_DIR = resolve(import.meta.dirname, '../../packages/sdk/src/workspace-tools')
export const GUEST_GIT_DIR = '/opt/hobwork/workspace-git'

const INSTALL_CLI = [
  `printf '#!/bin/sh\\nexec node --disable-warning=ExperimentalWarning ${CLI_DIR}/main.ts "$@"\\n' > /usr/local/bin/hobwork`,
  'chmod 755 /usr/local/bin/hobwork',
  `printf '#!/bin/sh\\nHOBWORK_GIT_DIR=${GUEST_GIT_DIR} exec node --disable-warning=ExperimentalWarning ${TOOLS_DIR}/main.ts "$@"\\n' > /usr/local/bin/${TOOL_COMMAND}`,
  `chmod 755 /usr/local/bin/${TOOL_COMMAND}`,
].join(' && ')

const BROKER_COMMAND = '/usr/local/bin/hobwork-broker'
const RUN_COMMAND = '/usr/local/bin/hobwork-run'
const SESSIONS_DIR = '/run/hobwork/sessions'

// Root-owned entry point of the `hobwork` CLI's helper. The image's doas
// configuration lets the agent user run exactly this path as root. It starts
// node with an empty environment, since the caller chooses the environment.
const BROKER_SCRIPT = `#!/bin/sh
exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/node --disable-warning=ExperimentalWarning ${CLI_DIR}/broker.ts "$@"
`

// Every command runs through this as root, which drops to the agent user. The
// session token of a command goes to a file only root reads, named after the
// command's process (the `hobwork` helper finds it from a calling process's
// parents), and out of the environment, so processes cannot read it.
const RUN_SCRIPT = `#!/bin/sh
if [ -n "\${HOBWORK_SESSION:-}" ]; then
  start=$(sed 's/^.*) //' /proc/$$/stat | cut -d ' ' -f 20)
  (umask 077; printf '%s\\n%s\\n' "$start" "$HOBWORK_SESSION" > ${SESSIONS_DIR}/$$)
  unset HOBWORK_SESSION
fi
export HOME=/home/agent USER=agent LOGNAME=agent
exec su-exec ${GUEST_UID}:${GUEST_GID} "$@"
`

// hidepid hides the processes of other users from the agent user, and Yama's
// ptrace scope stops it from attaching to processes it did not start.
const GUEST_SETUP = `
set -e
mkdir -p ${SESSIONS_DIR}
chmod 700 /run/hobwork ${SESSIONS_DIR}
echo 1 > /proc/sys/kernel/yama/ptrace_scope
mount -o remount,hidepid=2 /proc
mkdir -p /tmp/.cache /tmp/.config /tmp/.local/share
chown -R ${GUEST_UID}:${GUEST_GID} /tmp/.cache /tmp/.config /tmp/.local /home/agent
`

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

// Commands run as the agent user, which has no access to session tokens.
export function asAgent(command: string): string {
  return `exec ${RUN_COMMAND} /bin/sh -lc ${shellQuote(command)}`
}

// `setup` runs as root after the common setup, in the same shell.
export async function prepareGuest(
  sandbox: Sandbox,
  label: string,
  scripts: Record<string, string> = {},
  setup = '',
): Promise<void> {
  const all = { [RUN_COMMAND]: RUN_SCRIPT, ...scripts }
  try {
    for (const [path, content] of Object.entries(all)) await sandbox.writeFile(path, content)
    const result = await sandbox.exec(`${GUEST_SETUP}chmod 755 ${Object.keys(all).join(' ')}\n${setup}`).result
    if (result.exitCode !== 0) throw new Error(`Could not set up the guest user in ${label}: ${result.stderr}`)
  } catch (err) {
    await sandbox.stop()
    throw err
  }
}

// Answered by the workspace environment (the branch DB and Home Assistant);
// everything else on hobwork.internal goes to the CLI API.
export const ENVIRONMENT_PATHS = new Set(['/v1/db', '/v1/ha', '/v1/devices'])

const DISK_SIZE = '4G'
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

// What a workspace VM gets from the rest of the host: secrets, their hosts,
// and the internal endpoint with the branch DB.
export type VmEnvironment = {
  egress: string[]
  secrets: Record<string, Secret>
  internal?: InternalHandler
  intercept?: Interceptor
  onEgressBlocked?: (event: EgressBlocked) => void
  onSecretRefused?: (event: SecretRefused) => void
}

export type WorkspaceEnvironment = {
  // Called while a workspace VM starts. `vm` runs commands in that VM once it
  // is up, for the internal handler to use.
  start(workspace: Workspace, vm: Pick<ExecWorkspaceVm, 'exec'>): Promise<VmEnvironment>
  // Changes when start() would return different secrets or hosts, so the VM is replaced.
  fingerprint(workspace: Workspace): string
  stop?(workspace: Workspace): Promise<void>
}

export type GuestVmOptions = {
  image: string
  createSandbox: SandboxFactory
  log?: (message: string) => void
  workspaceEnvironment?: WorkspaceEnvironment
  // A file of the workspace's branch as committed, undefined when it does not
  // exist. The VM can write the checkout, so what decides a VM's egress and
  // resources must not come from there.
  readBranchFile?: (workspace: Workspace, path: string) => Promise<string | undefined>
}

export type GuestWorkspaceVm = InteractiveWorkspaceVm & {
  egress: string[]
}

function guestCwd(cwd: string): string {
  const path = posix.join(GUEST_DIR, cwd)
  if (path !== GUEST_DIR && !path.startsWith(`${GUEST_DIR}/`)) throw new Error(`cwd "${cwd}" is outside the checkout`)
  return path
}

async function readJson(text: string | undefined, parse: (text: string) => unknown = JSON.parse): Promise<unknown> {
  if (text === undefined) return undefined
  try {
    return parse(text)
  } catch {
    return undefined
  }
}

// Invalid files count as empty. The pipeline reports them, and the agent can
// still run commands to fix them.
export async function hobworkEgress(hobworkJson: string | undefined): Promise<string[]> {
  const config = await readJson(hobworkJson, parseHobworkJson)
  const egress = (config as { egress?: unknown } | undefined)?.egress
  return Array.isArray(egress) ? egress.filter((host): host is string => typeof host === 'string') : []
}

// What the hob asks for, capped at the defaults. Invalid files ask for nothing.
async function hobworkResources(hobworkJson: string | undefined, kind: ResourceKind) {
  const config = await readJson(hobworkJson, parseHobworkJson)
  const requested = (config as { resources?: ResourceRequest } | undefined)?.resources
  const ask = typeof requested === 'object' && requested !== null ? requested : undefined
  return resolveResources(kind, ask, DEFAULT_RESOURCES[kind])
}

export async function hasExtraDependencies(packageJson: string | undefined): Promise<boolean> {
  const pkg = await readJson(packageJson)
  return typeof pkg === 'object' && pkg !== null && extraDependencies(pkg).length > 0
}

// `dir` is mounted read-write at /workspace. node_modules lives on the VM disk:
// the filesystem bridge is slow for many small files, and it only holds extras.
function sandboxOptions(
  options: GuestVmOptions,
  dir: string,
  egress: string[],
  label: string,
  vm: { kind: VmKind; project: string; branch?: string; resources: { memoryMb: number; cpus: number } },
  environment?: VmEnvironment,
): SandboxOptions {
  return {
    image: options.image,
    budget: { kind: vm.kind, project: vm.project, branch: vm.branch },
    memory: memorySize(vm.resources.memoryMb),
    cpus: vm.resources.cpus,
    diskSize: DISK_SIZE,
    mounts: { [GUEST_DIR]: { hostPath: dir, vmDisk: ['node_modules'] } },
    // Without a TTY, pnpm refuses to recreate node_modules unless it runs in CI mode.
    // An environment setting beats a hob's pnpm-workspace.yaml, and unlike a
    // global config file it does not depend on where the VM's HOME or XDG_CONFIG_HOME point.
    env: { CI: 'true', pnpm_config_minimum_release_age: String(MIN_RELEASE_AGE_MINUTES) },
    egress,
    label,
    secrets: environment?.secrets,
    internal: environment?.internal,
    intercept: environment?.intercept,
    onEgressBlocked: (event) => {
      options.log?.(`${label}: blocked egress to ${event.hostname || event.ip}`)
      environment?.onEgressBlocked?.(event)
    },
    onSecretRefused: (event) => {
      options.log?.(`${label}: refused a request to ${event.hostname}: ${event.message}`)
      environment?.onSecretRefused?.(event)
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
    async exec(command: string, { cwd, timeoutMs, signal, env, input, onOutput }: ExecOptions): Promise<ExecResult> {
      const output = { stdout: new HeadTailOutput(), stderr: new HeadTailOutput() }
      running++
      try {
        const result = await sandbox.exec(asAgent(command), {
          cwd: guestCwd(cwd),
          timeoutMs,
          signal,
          env,
          input,
          onOutput: ({ stream, text }) => {
            output[stream].push(text)
            onOutput?.(stream, text)
          },
        }).result
        return { exitCode: exitCode(result), stdout: output.stdout.toString(), stderr: output.stderr.toString() }
      } finally {
        running--
      }
    },
    spawn(command, { cwd, env, pty, onData }) {
      const proc = sandbox.spawn(asAgent(command), { cwd: guestCwd(cwd), env, pty, onData })
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
    let started: Pick<ExecWorkspaceVm, 'exec'> | undefined
    const environment = await environments?.start(workspace, {
      exec: (command, execOptions) => {
        if (!started) throw new Error(`${label} is not running`)
        return started.exec(command, execOptions)
      },
    })
    // The registry is always reachable so agents can add and install extras.
    const readBranchFile = (path: string) => options.readBranchFile?.(workspace, path)
    const egress = [...new Set([NPM_REGISTRY, ...(await hobworkEgress(await readBranchFile('hobwork.json'))), ...(environment?.egress ?? [])])]
    const resources = await hobworkResources(await readBranchFile('hobwork.json'), 'workspace')
    const base = sandboxOptions(
      options,
      workspace.dir,
      egress,
      label,
      { kind: 'workspace', project: workspace.project, branch: workspace.branch, resources },
      environment,
    )
    const cliApi = internal?.(workspace)
    const environmentApi = environment?.internal
    let sandbox: Sandbox
    try {
      sandbox = await options.createSandbox({
        ...base,
        mounts: {
          ...base.mounts,
          [CLI_DIR]: { hostPath: HOST_CLI_DIR, readonly: true },
          [TOOLS_DIR]: { hostPath: HOST_TOOLS_DIR, readonly: true },
          [GUEST_GIT_DIR]: { hostPath: workspace.gitDir },
        },
        internal: (request) => {
          if (ENVIRONMENT_PATHS.has(new URL(request.url).pathname)) {
            if (!hasSession?.(workspace, request.headers.get(SESSION_HEADER) ?? '')) {
              return Response.json(
                { error: 'This only works in commands started over SSH or with the bash tool' },
                { status: 401 },
              )
            }
            if (environmentApi) return environmentApi(request)
          }
          return cliApi?.(request) ?? Response.json({ error: 'not found' }, { status: 404 })
        },
        streamInternal: streamsWorkspaceGitBody,
      })
    } catch (err) {
      await environments?.stop?.(workspace)
      throw err
    }
    await prepareGuest(sandbox, label, { [BROKER_COMMAND]: BROKER_SCRIPT }).catch(async (err: unknown) => {
      await environments?.stop?.(workspace)
      throw err
    })
    const cli = await sandbox.exec(INSTALL_CLI).result.catch((err: unknown) => err as Error)
    if (cli instanceof Error || cli.exitCode !== 0) {
      await sandbox.stop()
      await environments?.stop?.(workspace)
      throw new Error(`Could not install the hobwork CLI in ${label}: ${cli instanceof Error ? cli.message : cli.stderr}`)
    }
    const vm = execVm(sandbox)
    started = vm

    if (await hasExtraDependencies(await readBranchFile('package.json'))) {
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
        const current = new Set([NPM_REGISTRY, ...(await hobworkEgress(await readBranchFile('hobwork.json'))), ...(environment?.egress ?? [])])
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
    async start({ dir, project = '(host)', kind = 'pipeline' }) {
      // The checkout is fresh, so no VM has written to it yet.
      const hobworkJson = await readRegularFile(join(dir, 'hobwork.json'), 'hobwork.json').catch(() => undefined)
      const resources = await hobworkResources(hobworkJson, 'pipeline')
      const base = sandboxOptions(options, dir, [NPM_REGISTRY], kind, { kind, project, resources })
      const sandbox = await options.createSandbox({
        ...base,
        mounts: { ...base.mounts, [ICONS_DIR]: { hostPath: HOST_ICONS_DIR, readonly: true } },
      })
      running.add(sandbox)
      try {
        await prepareGuest(sandbox, kind)
      } catch (err) {
        running.delete(sandbox)
        throw err
      }
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
