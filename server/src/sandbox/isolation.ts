import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { machine, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { loadAssetManifest } from '@earendil-works/gondolin'
import type { Mount } from './sandbox.ts'
import type { VfsWorkerConfig } from './vfs-worker.ts'

export type Isolation = 'off' | 'namespaces'

export function isolationMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Isolation {
  const value = env.HOBWORK_SANDBOX_ISOLATION || 'off'
  if (value !== 'off' && value !== 'namespaces') {
    throw new Error(`HOBWORK_SANDBOX_ISOLATION must be "namespaces" or "off", not "${value}"`)
  }
  if (value === 'namespaces' && platform !== 'linux') throw new Error('HOBWORK_SANDBOX_ISOLATION=namespaces needs Linux')
  return value
}

// Every process started through bwrap gets its own user, mount, PID, network,
// IPC and UTS namespace, an empty root and none of the host's environment
// (which holds HOBWORK_SECRET_KEY and OIDC credentials).
const COMMON_PATH = '/usr/local/bin:/usr/bin:/bin'

const COMMON = [
  '--unshare-all',
  '--die-with-parent',
  '--new-session',
  '--cap-drop', 'ALL',
  '--clearenv',
  '--setenv', 'PATH', COMMON_PATH,
  '--proc', '/proc',
  '--dev', '/dev',
  '--tmpfs', '/tmp',
]

const SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64']

function systemBinds(): string[] {
  const args: string[] = []
  for (const path of SYSTEM_DIRS) {
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    // Merged-/usr systems link /bin and /lib into /usr.
    if (stat.isSymbolicLink()) args.push('--symlink', readlinkSync(path), path)
    else if (stat.isDirectory()) args.push('--ro-bind', path, path)
  }
  args.push('--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache')
  return args
}

// Binds a directory at the path the host uses and, when that path goes
// through a symlink, at its real path too, so paths the host hands out work
// either way.
function bindAtBothPaths(option: '--bind' | '--ro-bind', path: string): string[] {
  const given = resolve(path)
  const real = realpathSync(given)
  return real === given ? [option, real, real] : [option, real, real, option, real, given]
}

let checked: Error | undefined | null = null

// Run at host start when isolation is on, so a host that cannot create the
// namespaces fails right away with the reason, not on the first VM start.
export function checkIsolation(env: NodeJS.ProcessEnv = process.env): void {
  if (isolationMode(env) === 'off') return
  if (checked === null) checked = probeBwrap()
  if (checked) throw checked
}

function probeBwrap(): Error | undefined {
  const result = spawnSync('bwrap', [...COMMON, ...systemBinds(), '--', 'true'], { encoding: 'utf8', timeout: 10_000 })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return new Error('HOBWORK_SANDBOX_ISOLATION=namespaces needs bubblewrap (the bwrap command), which is not installed or not on PATH. Install bubblewrap or set HOBWORK_SANDBOX_ISOLATION=off.')
  }
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || `exit code ${result.status}`)
    return new Error([
      `HOBWORK_SANDBOX_ISOLATION=namespaces needs unprivileged user namespaces, and bwrap could not create them: ${reason}`,
      'Check that the sysctls kernel.unprivileged_userns_clone (where it exists) is 1, user.max_user_namespaces is above 0, and kernel.apparmor_restrict_unprivileged_userns (Ubuntu) is 0 or AppArmor allows bwrap,',
      'and that the service unit does not set RestrictNamespaces=yes or a SystemCallFilter that blocks unshare, mount or pivot_root. Or set HOBWORK_SANDBOX_ISOLATION=off.',
    ].join(' '))
  }
  return undefined
}

// systemd sets RUNTIME_DIRECTORY for `RuntimeDirectory=hobwork` (/run/hobwork).
export function runtimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromSystemd = env.RUNTIME_DIRECTORY?.split(':')[0]
  const root = fromSystemd || join(tmpdir(), `hobwork-${process.getuid?.() ?? 'run'}`)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  // In a shared /tmp someone else could have created it first.
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${root} must be a directory owned by this user with mode 700`)
  }
  return root
}

export type VmDir = {
  path: string
  // Sockets QEMU connects to and the root disk overlay.
  vm: string
  // Socket of the VFS worker.
  fs: string
  // Gondolin's own fs socket, which nothing connects to. Outside `path`, so
  // QEMU cannot reach the host's VFS.
  unusedFs: string
  remove(): void
}

// One directory per VM under the runtime root, which is all of the host's
// state its QEMU process can see.
export function createVmDir(root: string = runtimeRoot()): VmDir {
  const base = join(root, 'vm')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const path = mkdtempSync(join(base, 'v'))
  const vm = join(path, 'vm')
  const fs = join(path, 'fs')
  const unusedFs = `${path}.fs.sock`
  mkdirSync(vm, { mode: 0o700 })
  mkdirSync(fs, { mode: 0o700 })
  return {
    path,
    vm,
    fs,
    unusedFs,
    remove: () => {
      rmSync(path, { recursive: true, force: true })
      rmSync(unusedFs, { force: true })
    },
  }
}

export type QemuSetup = {
  rootDiskPath: string
  rootDiskFormat: 'qcow2'
  rootDiskDeleteOnClose: true
  virtioSocketPath: string
  virtioFsSocketPath: string
  virtioSshSocketPath: string
  virtioIngressSocketPath: string
  netSocketPath: string
}

const SHIM_DIR = realpathSync(import.meta.dirname)
const RELEASE_ROOT = resolve(SHIM_DIR, '../../..')
const WORKER = join(SHIM_DIR, 'vfs-worker.ts')
const WORKER_START_TIMEOUT_MS = 30_000

// Writes what qemu-namespaced.sh needs next to the VM's sockets: the bwrap
// options (read with `bwrap --args`) and the root disk overlay, whose backing
// file QEMU opens at the same absolute path inside its namespace.
export function prepareQemu(dir: VmDir, image: string): QemuSetup {
  const manifest = loadAssetManifest(image) as { assets?: { rootfs?: string } } | null
  const rootfs = realpathSync(join(image, manifest?.assets?.rootfs ?? 'rootfs.ext4'))
  const disk = join(dir.vm, 'disk.qcow2')
  execFileSync('qemu-img', ['create', '-q', '-f', 'qcow2', '-F', 'raw', '-b', rootfs, disk], { stdio: ['ignore', 'ignore', 'pipe'] })
  writeFileSync(join(dir.path, 'qemu.bwrap'), qemuBwrapArgs({ dir: dir.path, image }).map((arg) => `${arg}\0`).join(''))
  return {
    rootDiskPath: disk,
    rootDiskFormat: 'qcow2',
    rootDiskDeleteOnClose: true,
    virtioSocketPath: join(dir.vm, 'control.sock'),
    virtioFsSocketPath: dir.unusedFs,
    virtioSshSocketPath: join(dir.vm, 'ssh.sock'),
    virtioIngressSocketPath: join(dir.vm, 'ingress.sock'),
    netSocketPath: join(dir.vm, 'net.sock'),
  }
}

function hasKvm(): boolean {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function findQemu(pathVar = process.env.PATH ?? ''): string | undefined {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    const path = join(dir, `qemu-system-${machine()}`)
    try {
      accessSync(path, constants.X_OK)
      return realpathSync(path)
    } catch {}
  }
  return undefined
}

// A QEMU outside the system directories (Nix, /opt) needs its install prefix,
// where it also finds firmware and libraries, and its bin directory on PATH,
// since bwrap looks up the command in the namespace's environment.
function qemuInstallBinds(qemu: string | undefined): string[] {
  if (!qemu || SYSTEM_DIRS.some((dir) => qemu.startsWith(`${dir}/`))) return []
  const bin = dirname(qemu)
  // Nix links every library from another store path.
  const prefix = qemu.startsWith('/nix/store/') ? '/nix/store' : dirname(bin)
  return ['--ro-bind', prefix, prefix, '--setenv', 'PATH', `${bin}:${COMMON_PATH}`]
}

export function qemuBwrapArgs(options: { dir: string, image: string, kvm?: boolean, qemu?: string }): string[] {
  const kvm = options.kvm ?? hasKvm()
  return [
    ...COMMON,
    ...systemBinds(),
    ...qemuInstallBinds('qemu' in options ? options.qemu : findQemu()),
    ...(kvm ? ['--dev-bind', '/dev/kvm', '/dev/kvm'] : []),
    ...bindAtBothPaths('--ro-bind', options.image),
    // For qemu-sandboxed.sh.
    '--ro-bind', SHIM_DIR, SHIM_DIR,
    '--bind', options.dir, options.dir,
  ]
}

export function workerBwrapArgs(options: { fs: string, mounts: Mount[], node: string }): string[] {
  const prefix = dirname(dirname(options.node))
  const nodeBind = prefix === '/' || prefix === '/usr' || prefix.startsWith('/usr/') ? [] : ['--ro-bind', prefix, prefix]
  const release = ['server/package.json', 'server/node_modules', 'node_modules', 'vendor/gondolin'].map((p) => join(RELEASE_ROOT, p))
  const mounts = [...options.mounts].sort((a, b) => resolve(a.hostPath).length - resolve(b.hostPath).length)
  return [
    ...COMMON,
    // Gondolin reads the home directory when it loads, and there is no /etc/passwd.
    '--setenv', 'HOME', '/tmp',
    ...systemBinds(),
    ...nodeBind,
    ...[SHIM_DIR, ...release].flatMap((p) => ['--ro-bind', p, p]),
    '--bind', options.fs, options.fs,
    ...mounts.flatMap((mount) => bindAtBothPaths(mount.readonly ? '--ro-bind' : '--bind', mount.hostPath)),
  ]
}

export type VfsWorker = {
  // Resolves once the worker listens on its socket.
  ready: Promise<void>
  exited: Promise<void>
  stop(): void
}

export function startVfsWorker(dir: VmDir, mounts: Record<string, Mount>, mitmCaCertificate: string): VfsWorker {
  const node = realpathSync(process.execPath)
  const child = spawn('bwrap', [...workerBwrapArgs({ fs: dir.fs, mounts: Object.values(mounts), node }), '--', node, WORKER], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const config: VfsWorkerConfig = { socketPath: join(dir.fs, 'fs.sock'), mounts, mitmCaCertificate }
  child.stdin.on('error', () => {})
  child.stdin.write(`${JSON.stringify(config)}\n`)
  let stderr = ''
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderr = `${stderr}${line}\n`.slice(-4000)
    console.warn(`vfs worker ${child.pid}: ${line}`)
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  const stop = () => {
    child.stdin.end()
    child.kill('SIGKILL')
  }
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the VFS worker did not start within ${WORKER_START_TIMEOUT_MS / 1000}s: ${stderr.trim()}`))
      stop()
    }, WORKER_START_TIMEOUT_MS)
    createInterface({ input: child.stdout }).once('line', (line) => {
      clearTimeout(timer)
      if (line === 'ready') resolve()
      else reject(new Error(`unexpected output from the VFS worker: ${line}`))
    })
    child.once('error', (err) => reject(new Error(`could not start the VFS worker: ${err.message}`)))
    void exited.then(() => {
      clearTimeout(timer)
      reject(new Error(`the VFS worker exited before it was ready: ${stderr.trim()}`))
    })
  })
  ready.catch(() => {})
  return { ready, exited, stop }
}

export function isolationAvailableForTests(): boolean {
  if (process.platform !== 'linux' || !existsSync('/proc/self/ns/user')) return false
  return probeBwrap() === undefined
}
