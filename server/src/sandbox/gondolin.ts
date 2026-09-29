import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import {
  createHttpHooks,
  createShadowPathPredicate,
  ReadonlyProvider,
  RealFSProvider,
  ShadowProvider,
  VM,
} from '@earendil-works/gondolin'
import type { VirtualProvider } from '@earendil-works/gondolin'
import {
  INTERNAL_HOST,
  type ExecOptions,
  type ExecResult,
  type InteractiveProcess,
  type Mount,
  type OutputChunk,
  type Sandbox,
  type SandboxOptions,
  type SandboxProcess,
  type SpawnOptions,
} from './sandbox.ts'

const KILL_GRACE_MS = 2000
const EXEC_ID_VAR = 'HOBWORK_EXEC_ID'

// Gondolin has no way to signal a guest process (aborting an exec only stops
// waiting for it). Every exec gets a unique env var, which its children
// inherit, so a kill finds the whole process tree through /proc even if
// something in it started a new session.
const KILL_SCRIPT = `
for f in /proc/[0-9]*/environ; do
  if tr '\\0' '\\n' < "$f" 2>/dev/null | grep -qx "${EXEC_ID_VAR}=$1"; then
    p=\${f#/proc/}
    kill -"$2" "\${p%/environ}" 2>/dev/null
  fi
done
true
`

export async function createGondolinSandbox(options: SandboxOptions): Promise<Sandbox> {
  const internal = options.internal
  const hooks = createHttpHooks({
    allowedHosts: options.egress ?? [],
    secrets: options.secrets,
    // Gondolin injects secrets after onRequest, so the internal handler only sees placeholders.
    onRequest: internal
      ? (request) => (new URL(request.url).hostname === INTERNAL_HOST ? internal(request) : undefined)
      : undefined,
  })
  const isIpAllowed = hooks.httpHooks.isIpAllowed
  const onBlocked = options.onEgressBlocked
  if (isIpAllowed && onBlocked) {
    hooks.httpHooks.isIpAllowed = async (info) => {
      const allowed = await isIpAllowed(info)
      if (!allowed) onBlocked({ hostname: info.hostname, ip: info.ip, port: info.port })
      return allowed
    }
  }

  const vm = await VM.create({
    sandbox: { imagePath: options.image },
    memory: options.memory ?? '1G',
    cpus: options.cpus ?? 2,
    rootfs: { mode: 'cow', size: options.diskSize },
    env: { ...options.env, ...hooks.env },
    httpHooks: hooks.httpHooks,
    vfs: { mounts: toProviders(options.mounts ?? {}) },
    sessionLabel: options.label,
  })
  // VM.create boots lazily on first use. Booting here surfaces boot errors to the caller.
  try {
    await vm.start()
    await bindVmDiskDirs(vm, options.mounts ?? {})
  } catch (err) {
    await vm.close()
    throw err
  }
  return new GondolinSandbox(vm)
}

function toProviders(mounts: Record<string, Mount>): Record<string, VirtualProvider> {
  return Object.fromEntries(Object.entries(mounts).map(([guestPath, mount]) => [guestPath, toProvider(mount)]))
}

function relativePaths(paths: string[] | undefined): string[] {
  return (paths ?? []).map((p) => p.replace(/^\/+|\/+$/g, ''))
}

function toProvider(mount: Mount): VirtualProvider {
  let provider: VirtualProvider = new RealFSProvider(mount.hostPath)
  if (mount.readonly) provider = new ReadonlyProvider(provider)
  const hidden = [...relativePaths(mount.hide), ...relativePaths(mount.vmDisk)]
  if (hidden.length) {
    // Outside the readonly wrapper so the guest can still create the vmDisk mount points.
    provider = new ShadowProvider(provider, {
      shouldShadow: createShadowPathPredicate(hidden.map((p) => `/${p}`)),
      writeMode: 'tmpfs',
    })
  }
  return provider
}

async function bindVmDiskDirs(vm: VM, mounts: Record<string, Mount>): Promise<void> {
  const targets = Object.entries(mounts).flatMap(([guestPath, mount]) =>
    relativePaths(mount.vmDisk).map((p) => `${guestPath.replace(/\/+$/, '')}/${p}`))
  if (targets.length === 0) return
  // /var/lib is on the root disk (unlike /tmp and /var/tmp, which are tmpfs).
  const script = `
set -e
i=0
for target in "$@"; do
  i=$((i + 1))
  mkdir -p "/var/lib/hobwork/vm-disk/$i" "$target"
  mount --bind "/var/lib/hobwork/vm-disk/$i" "$target"
done
`
  const result = await vm.exec(['/bin/sh', '-c', script, 'bind', ...targets])
  if (result.exitCode !== 0) throw new Error(`could not set up VM disk directories: ${result.stderr}`)
}

class GondolinSandbox implements Sandbox {
  readonly id: string
  #vm: VM
  #ingressUrl: Promise<string> | undefined

  constructor(vm: VM) {
    this.#vm = vm
    this.id = vm.id
  }

  exec(command: string, options: ExecOptions = {}): SandboxProcess {
    const execId = randomUUID()
    const onOutput = options.onOutput
    let timedOut = false
    let killed = false
    let killing: Promise<void> | undefined

    const proc = this.#vm.exec(command, {
      cwd: options.cwd,
      env: { ...options.env, [EXEC_ID_VAR]: execId },
      stdout: onOutput ? decodingWriter('stdout', onOutput) : 'buffer',
      stderr: onOutput ? decodingWriter('stderr', onOutput) : 'buffer',
    })

    const kill = (): Promise<void> => {
      killed = true
      killing ??= this.#kill(execId, proc)
      return killing
    }

    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          void kill()
        }, options.timeoutMs)
    const onAbort = () => void kill()
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    const result = (async (): Promise<ExecResult> => {
      try {
        const r = await proc
        return {
          exitCode: r.exitCode,
          signal: r.signal,
          timedOut,
          killed,
          stdout: onOutput ? '' : r.stdout,
          stderr: onOutput ? '' : r.stderr,
        }
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
    })()

    return { result, kill }
  }

  spawn(command: string, options: SpawnOptions): InteractiveProcess {
    const execId = randomUUID()
    const proc = this.#vm.exec(command, {
      cwd: options.cwd,
      env: { ...options.env, [EXEC_ID_VAR]: execId },
      stdin: true,
      pty: options.pty !== undefined,
      stdout: bytesWriter((data) => options.onData('stdout', data)),
      stderr: bytesWriter((data) => options.onData('stderr', data)),
    })
    if (options.pty) proc.resize(options.pty.rows, options.pty.cols)
    let killing: Promise<void> | undefined
    return {
      result: proc.then((r) => ({ exitCode: r.exitCode, signal: r.signal })),
      write: (data) => proc.write(Buffer.from(data)),
      end: () => proc.end(),
      resize: (rows, cols) => proc.resize(rows, cols),
      kill: () => (killing ??= this.#kill(execId, proc)),
    }
  }

  async #kill(execId: string, proc: PromiseLike<unknown>): Promise<void> {
    await this.#signal(execId, 'TERM')
    const exited = await Promise.race([
      Promise.resolve(proc).then(() => true, () => true),
      new Promise<false>((resolve) => setTimeout(resolve, KILL_GRACE_MS, false)),
    ])
    if (!exited) await this.#signal(execId, 'KILL')
  }

  async #signal(execId: string, signal: 'TERM' | 'KILL'): Promise<void> {
    await this.#vm.exec(['/bin/sh', '-c', KILL_SCRIPT, 'kill', execId, signal])
  }

  ingress(port: number): Promise<string> {
    this.#ingressUrl ??= this.#vm.enableIngress({ listenPort: 0 }).then((access) => access.url)
    return this.#ingressUrl.then((url) => {
      this.#vm.setIngressRoutes([{ prefix: '/', port, stripPrefix: true }])
      return url
    })
  }

  async readFile(path: string): Promise<Buffer> {
    return this.#vm.fs.readFile(path)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.#vm.fs.writeFile(path, data)
  }

  hostPid(): number | null {
    return this.#vm.getHostPid()
  }

  async stop(): Promise<void> {
    await this.#vm.close()
  }
}

function bytesWriter(onData: (data: Buffer) => void): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      onData(chunk)
      callback()
    },
  })
}

function decodingWriter(stream: OutputChunk['stream'], onOutput: (chunk: OutputChunk) => void): Writable {
  const decoder = new StringDecoder('utf8')
  const emit = (text: string) => {
    if (text) onOutput({ stream, text })
  }
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      emit(decoder.write(chunk))
      callback()
    },
    final(callback) {
      emit(decoder.end())
      callback()
    },
  })
}
