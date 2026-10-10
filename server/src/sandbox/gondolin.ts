import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createHttpHooks, MemoryProvider, VM } from '@earendil-works/gondolin'
import type { VirtualProvider } from '@earendil-works/gondolin'
import {
  GUEST_GID,
  GUEST_UID,
  INTERNAL_HOST,
  type ExecOptions,
  type ExecResult,
  type InteractiveProcess,
  type Mount,
  type OutputChunk,
  type Sandbox,
  type SandboxOptions,
  type SandboxProcess,
  type Secret,
  type SpawnOptions,
} from './sandbox.ts'
import { hostNetworksBlockList, isPublicAddress } from '../public-address.ts'
import { egressAllows, egressHosts, egressRules, privateEgressAllows } from './egress.ts'
import { requestHook, upstreamFetch } from './intercept.ts'
import { checkIsolation, createVmDir, isolationMode, prepareQemu, startVfsWorker, type VfsWorker, type VmDir } from './isolation.ts'
import { relativePaths, toProviders } from './mounts.ts'
import { qemuPath } from './qemu.ts'
import { systemEnv } from './system-env.ts'

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

const hostNetworks = hostNetworksBlockList()

export async function createGondolinSandbox(options: SandboxOptions): Promise<Sandbox> {
  const internal = options.internal
  const egress = options.egress ?? []
  const rules = egressRules(egress)
  const privateEgress = options.privateEgress ?? []
  const onBlocked = options.onEgressBlocked
  const reportRefusal = refusalReporter(options.onSecretRefused)
  const hooks = createHttpHooks({
    allowedHosts: egressHosts(rules),
    // isIpAllowed below refuses internal ranges itself, except for targets
    // the host's operator allows.
    blockInternalRanges: false,
    secrets: options.secrets,
    // Gondolin checks the allowlist only after resolving the name, so a host
    // that does not resolve would fail with a 502 and never reach the blocked
    // callback. Checking the name first answers 403 and reports it.
    isRequestAllowed: (request) => {
      const { hostname, port, protocol } = new URL(request.url)
      const target = Number(port) || (protocol === 'https:' ? 443 : 80)
      if (hostname === INTERNAL_HOST || egressAllows(rules, hostname, target)) return true
      onBlocked?.({ hostname, ip: '', port: target })
      return false
    },
    // Gondolin's own range check misses NAT64, 6to4 and IPv4-compatible
    // encodings of private IPv4 addresses and the LAN's global IPv6 prefixes,
    // so an allowed name could still lead to a LAN device. It also runs on
    // every connection, so a name that resolves differently later is checked again.
    isIpAllowed: (info) => {
      // isRequestAllowed already reported it.
      if (!egressAllows(rules, info.hostname, info.port)) return false
      if (isPublicAddress(info.ip, { extraBlocked: hostNetworks() }) || privateEgressAllows(privateEgress, info)) return true
      onBlocked?.({ hostname: info.hostname, ip: info.ip, port: info.port, private: true })
      return false
    },
    // Streamed bodies have no size limit, so only hobwork.internal handlers,
    // which bound what they read, can opt in.
    streamRequestBody: (request) =>
      new URL(request.url).hostname === INTERNAL_HOST && (options.streamInternal?.(request) ?? false),
    // Gondolin injects secrets after onRequest, so the internal handler and
    // the interceptor only see placeholders.
    onRequest: async (request) => {
      const blocked = new URL(request.url).hostname === INTERNAL_HOST ? undefined : refuse(request)
      if (blocked) return Response.json({ error: { code: 'hobwork_secret_not_allowed', message: blocked } }, { status: 403 })
      return hook?.(request)
    },
  })
  const misplacedSecret = secretGuard(options.secrets ?? {}, hooks.env)
  const refuse = (request: Request) => {
    const message = misplacedSecret(request)
    if (message) reportRefusal(new URL(request.url).hostname, message)
    return message
  }
  const fillSecrets = secretFiller(options.secrets ?? {}, hooks.env)
  const hook = requestHook({
    internal,
    intercept: options.intercept,
    egress: rules,
    upstream: upstreamFetch((request) => {
      const blocked = refuse(request)
      if (blocked) throw new Error(blocked)
      return fillSecrets(request)
    }),
  })

  checkIsolation()
  const mounts = options.mounts ?? {}
  const isolated = isolationMode() === 'namespaces' ? await startIsolated(mounts) : undefined
  let vm: VM
  try {
    vm = await VM.create({
      sandbox: {
        imagePath: options.image,
        append: KERNEL_APPEND,
        qemuPath: qemuPath(),
        ...(isolated && prepareQemu(isolated.dir, options.image)),
      },
      memory: options.memory ?? '1G',
      cpus: options.cpus ?? 2,
      rootfs: { mode: 'cow', size: options.diskSize },
      env: { ...systemEnv(), ...options.env, ...hooks.env },
      httpHooks: hooks.httpHooks,
      vfs: { mounts: isolated ? placeholders(mounts) : toProviders(mounts) },
      sessionLabel: options.label,
    })
  } catch (err) {
    isolated?.close()
    throw err
  }
  try {
    await isolated?.worker.ready
  } catch (err) {
    await vm.close()
    isolated?.close()
    throw err
  }
  // VM.create boots lazily on first use. Booting here surfaces boot errors to the caller.
  try {
    await vm.start()
    await bindVmDiskDirs(vm, mounts)
  } catch (err) {
    await vm.close()
    isolated?.close()
    throw err
  }
  return new GondolinSandbox(vm, isolated)
}

type Isolated = { dir: VmDir, worker: VfsWorker, close(): void }

async function startIsolated(mounts: Record<string, Mount>): Promise<Isolated> {
  const dir = createVmDir()
  try {
    const { mitmCaCertificate } = await import('./gondolin-internals.ts')
    const worker = startVfsWorker(dir, mounts, await mitmCaCertificate())
    return {
      dir,
      worker,
      close: () => {
        worker.stop()
        dir.remove()
      },
    }
  } catch (err) {
    dir.remove()
    throw err
  }
}

// The VFS worker serves the mounts. Gondolin still needs a provider per guest
// path to pass the mount list to the guest.
function placeholders(mounts: Record<string, Mount>): Record<string, VirtualProvider> {
  return Object.fromEntries(Object.keys(mounts).map((guestPath) => [guestPath, new MemoryProvider()]))
}

// A guest that retries a refused request in a loop would otherwise fill the hob log.
const REFUSAL_REPORT_INTERVAL_MS = 60_000

export function refusalReporter(report: SandboxOptions['onSecretRefused']): (hostname: string, message: string) => void {
  const last = new Map<string, number>()
  return (hostname, message) => {
    if (!report) return
    const key = `${hostname}\0${message}`
    const now = Date.now()
    const before = last.get(key)
    if (before !== undefined && now - before < REFUSAL_REPORT_INTERVAL_MS) return
    if (last.size >= 100) last.clear()
    last.set(key, now)
    report({ hostname, message })
  }
}

function basicCredentials(value: string): string {
  const match = /^Basic\s+(\S+)\s*$/i.exec(value)
  return match ? Buffer.from(match[1]!, 'base64').toString('utf8') : ''
}

// Secrets are only filled in over https, in the Authorization header and the
// headers a secret lists. Gondolin would fill them into any header, and a
// value sent in a header Hobwork does not know about can end up in places
// like a server's access log. Returns why a request must not go out.
export function secretGuard(
  secrets: Record<string, Secret>,
  placeholders: Record<string, string>,
): (request: Request) => string | undefined {
  return (request) => {
    const secure = new URL(request.url).protocol === 'https:'
    for (const [name, secret] of Object.entries(secrets)) {
      const placeholder = placeholders[name]
      if (!placeholder) continue
      const allowed = new Set(['authorization', ...(secret.headers ?? []).map((header) => header.toLowerCase())])
      for (const [header, value] of request.headers) {
        if (!value.includes(placeholder) && !basicCredentials(value).includes(placeholder)) continue
        if (!secure) return `Hobwork only sends ${name} over https. Use an https:// URL.`
        if (!allowed.has(header.toLowerCase())) {
          const names = ['Authorization', ...(secret.headers ?? [])]
          const where = names.length === 1 ? 'the Authorization header' : `the ${names.join(', ')} headers`
          return `Hobwork only sends ${name} in ${where}. Found it in the ${header} header. People can add headers to the secret in Hobwork.`
        }
      }
    }
    return undefined
  }
}

// Fills in secrets for requests the interceptor sends itself, which skip
// Gondolin's hooks. `placeholders` are the ones the guest got, by env name.
export function secretFiller(
  secrets: Record<string, Secret>,
  placeholders: Record<string, string>,
): (request: Request) => Promise<Request> {
  const hooks = createHttpHooks({
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, secret]) => [name, { ...secret, placeholder: placeholders[name] }]),
    ),
  })
  return async (request) => (await hooks.httpHooks.onRequest!(request)) as Request
}

// QEMU's microvm machine has no CMOS RTC or i8042, and the kernel spends about 1.3s probing them.
// Every byte written to the emulated UART is a VM exit, so boot output goes to tty0 unless
// HOBWORK_VM_CONSOLE=1 is set for debugging.
const KERNEL_APPEND = process.platform === 'linux' && process.arch === 'x64'
  ? [
      process.env.HOBWORK_VM_CONSOLE === '1' ? 'console=ttyS0' : 'console=tty0 quiet',
      'initramfs_async=1 initcall_blacklist=cmos_init i8042.noaux i8042.nomux i8042.nopnp',
    ].join(' ')
  : undefined

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
  chown ${GUEST_UID}:${GUEST_GID} "/var/lib/hobwork/vm-disk/$i"
  mount --bind "/var/lib/hobwork/vm-disk/$i" "$target"
done
`
  const result = await vm.exec(['/bin/sh', '-c', script, 'bind', ...targets])
  if (result.exitCode !== 0) throw new Error(`could not set up VM disk directories: ${result.stderr}`)
}

type GuestFiles = {
  readGuestFile(path: string): Promise<Buffer>
  writeGuestFile(path: string, data: Buffer | Uint8Array | string): Promise<void>
}

class GondolinSandbox implements Sandbox {
  readonly id: string
  readonly exited: Promise<void>
  #vm: VM
  #server: GuestFiles | undefined
  #isolated: Isolated | undefined
  #stopping = false
  #ingressUrl: Promise<string> | undefined

  constructor(vm: VM, isolated: Isolated | undefined) {
    this.#vm = vm
    this.#isolated = isolated
    this.id = vm.id
    this.#server = (vm as unknown as { server?: GuestFiles }).server
    this.exited = vm.exited
    if (isolated) {
      void this.exited.then(() => {
        this.#stopping = true
        isolated.close()
      })
      // The guest's mounts fail without it, so the VM is of no use.
      void isolated.worker.exited.then(() => {
        if (this.#stopping) return
        console.warn(`The VFS worker of VM ${this.id} exited. Stopping the VM.`)
        void this.stop()
      })
    }
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
      stdin: options.input,
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
    // Gondolin answers 502 when the guest takes over 2s to send headers. The
    // runner only answers once the handler finishes, and callers set their own
    // timeouts, so Gondolin's are off.
    this.#ingressUrl ??= this.#vm
      .enableIngress({ listenPort: 0, upstreamHeaderTimeoutMs: 0, upstreamResponseTimeoutMs: 0 })
      .then((access) => access.url)
    return this.#ingressUrl.then((url) => {
      this.#vm.setIngressRoutes([{ prefix: '/', port, stripPrefix: true }])
      return url
    })
  }

  // With isolation the host's VFS only has placeholders, and Gondolin would
  // read and write mounted paths there instead of asking the guest.
  async readFile(path: string): Promise<Buffer> {
    if (this.#isolated && this.#server) return this.#server.readGuestFile(path)
    return this.#vm.fs.readFile(path)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    if (this.#isolated && this.#server) return this.#server.writeGuestFile(path, data)
    await this.#vm.fs.writeFile(path, data)
  }

  hostPid(): number | null {
    return this.#vm.getHostPid()
  }

  async stop(): Promise<void> {
    this.#stopping = true
    await this.#vm.close()
    this.#isolated?.close()
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
