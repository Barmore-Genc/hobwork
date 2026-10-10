import type { PrivateEgressRule } from './egress.ts'

// Hostname that guests use to reach the host (SDK calls). Requests to it never
// leave the host: the sandbox answers them with `SandboxOptions.internal`.
export const INTERNAL_HOST = 'hobwork.internal'

// The unprivileged user that runs hob code in guests. The image creates it
// with this ID, and the vendored Gondolin's sandboxfs shows every mounted file
// as owned by it.
export const GUEST_UID = 1000
export const GUEST_GID = 1000

export type Mount = {
  hostPath: string
  readonly?: boolean
  // Writes that would take the directory past this many bytes fail with ENOSPC.
  // Meant for mounts whose contents the host keeps, since the guest cannot be
  // trusted to stay small.
  maxBytes?: number
  // Paths relative to the mount root (e.g. `node_modules`, `.env`) that the
  // guest must not see. Guest writes to them go to memory and are discarded.
  hide?: string[]
  // Paths relative to the mount root (e.g. `node_modules`) that live on the VM's own
  // disk instead of the host, because the host filesystem bridge is slow for many
  // small files. Hidden from the host side. Contents are discarded on stop.
  vmDisk?: string[]
}

export type Secret = {
  value: string
  // The real value is only sent to these hosts. Wildcards like `*.example.com` work.
  hosts: string[]
  // Header names besides Authorization that the real value may be sent in.
  headers?: string[]
}

export type InternalHandler = (request: Request) => Response | Promise<Response>

// A request Hobwork refused to send because a secret was in a header it may not go in, or the URL was http.
export type SecretRefused = { hostname: string, message: string }

// `private`: the address is private and the host's HOBWORK_PRIVATE_EGRESS does not list it.
export type EgressBlocked = { hostname: string, ip: string, port: number, private?: boolean }

// Sends a request on to where it was going, with secrets filled in like any
// other guest request.
export type Upstream = (request: Request) => Promise<Response>

// Takes the guest's requests to some hosts, which then only reach them through
// `handle`. Hosts that are not in the egress allowlist stay blocked. The host
// connects to these itself, without the check against internal addresses, so
// they must be well-known public hosts.
export type Interceptor = {
  hosts: string[]
  handle: (request: Request, upstream: Upstream) => Promise<Response>
}

export type VmKind = 'runtime' | 'preview' | 'build' | 'pipeline' | 'workspace'

export type SandboxOptions = {
  // Directory with the guest image (manifest.json, kernel, initramfs, rootfs).
  image: string
  // What the VM is for, which the host's VM budget needs to schedule it.
  // VMs without it count as pipeline VMs of no hob.
  budget?: { kind: VmKind; project: string; branch?: string }
  memory?: string
  cpus?: number
  // Minimum root disk size, e.g. `4G`. Writes to the root disk are discarded on stop.
  diskSize?: string
  // Guest path -> host directory.
  mounts?: Record<string, Mount>
  env?: Record<string, string>
  // Hosts the guest may reach over HTTP(S), as `host` (any port) or
  // `host:port`. Everything else gets a 403.
  egress?: string[]
  // Private targets the host's operator allows. Private addresses are blocked
  // unless both these and `egress` allow them.
  privateEgress?: PrivateEgressRule[]
  // Env var name -> secret. The guest only ever sees a placeholder.
  secrets?: Record<string, Secret>
  internal?: InternalHandler
  // Requests to hobwork.internal that this returns true for reach `internal`
  // with their body as a stream. They are not buffered and have no size limit,
  // so `internal` must bound what it reads. Gets the request head only.
  streamInternal?: (request: Request) => boolean
  intercept?: Interceptor
  onEgressBlocked?: (event: EgressBlocked) => void
  // Called at most once a minute per host and reason.
  onSecretRefused?: (event: SecretRefused) => void
  label?: string
}

export type OutputChunk = { stream: 'stdout' | 'stderr', text: string }

export type ExecOptions = {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  // Written to the command's stdin, which is then closed.
  input?: string
  // When set, output is streamed here and not buffered into the result.
  onOutput?: (chunk: OutputChunk) => void
}

export type ExecResult = {
  exitCode: number
  // Set when the process was ended by a signal (e.g. 9 or 15 after a kill).
  signal?: number
  timedOut: boolean
  killed: boolean
  stdout: string
  stderr: string
}

export type SandboxProcess = {
  result: Promise<ExecResult>
  // Ends the process and everything it started: SIGTERM, then SIGKILL after a grace period.
  kill(): Promise<void>
}

export type SpawnOptions = {
  cwd?: string
  env?: Record<string, string>
  // Allocates a pseudo-terminal of this size. Output then arrives on stdout only.
  pty?: { rows: number, cols: number }
  onData: (stream: OutputChunk['stream'], data: Buffer) => void
}

// A process with stdin, for interactive sessions. Output is passed on as raw bytes.
export type InteractiveProcess = {
  result: Promise<{ exitCode: number, signal?: number }>
  write(data: string | Uint8Array): void
  // Closes stdin.
  end(): void
  resize(rows: number, cols: number): void
  kill(): Promise<void>
}

export interface Sandbox {
  readonly id: string
  // Resolves once the VM's process has ended, whether by stop() or on its own
  // (a crash, or the guest powering off).
  readonly exited: Promise<void>
  // `command` runs through a login shell (`/bin/sh -lc`). Several commands can run at once.
  exec(command: string, options?: ExecOptions): SandboxProcess
  spawn(command: string, options: SpawnOptions): InteractiveProcess
  // Routes HTTP requests on the returned host URL to a server listening on the guest's
  // 127.0.0.1:<port>. Calling it again with another port moves the route.
  ingress(port: number): Promise<string>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  // Host process ID of the VM, for resource accounting. Null when not running.
  hostPid(): number | null
  stop(): Promise<void>
}

export type SandboxFactory = (options: SandboxOptions) => Promise<Sandbox>
