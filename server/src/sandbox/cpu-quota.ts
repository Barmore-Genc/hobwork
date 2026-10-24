import { mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// cgroup v2 gives out CPU time in periods, and a share is a quota within one.
const PERIOD_US = 100_000

// A VM starts processes while it is moved into its cgroup, so the move looks
// again before it gives up.
const MOVE_ATTEMPTS = 20
const MOVE_RETRY_MS = 10
const RELEASE_ATTEMPTS = 20
const RELEASE_RETRY_MS = 50

export type CpuQuota = { mode: 'cgroup', base: string } | { mode: 'none', reason: string }

export type CgroupIo = {
  read(path: string): string
  // Writes a whole value to a cgroup file, which applies it at once.
  write(path: string, value: string): void
  mkdir(path: string): void
  remove(path: string): void
  // The processes below `pid`, including it.
  tree(pid: number): number[]
}

const realIo: CgroupIo = {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, value) => writeFileSync(path, value),
  mkdir: (path) => void mkdirSync(path, { recursive: true }),
  remove: (path) => rmdirSync(path),
  tree: processTree,
}

let cached: CpuQuota | undefined

export function cpuQuota(): CpuQuota {
  cached ??= probeCpuQuota(process.platform, realIo)
  return cached
}

// Whether the host can hold a VM to a share of a core, by really making one:
// a kernel or a container can allow every piece of this and still refuse the
// quota, and the answer decides what the defaults and hobwork.json may say.
export function probeCpuQuota(platform: NodeJS.Platform, io: CgroupIo): CpuQuota {
  if (platform !== 'linux') return { mode: 'none', reason: 'it does not run Linux' }
  const mountinfo = tryRead('/proc/self/mountinfo', io)
  const selfCgroup = tryRead('/proc/self/cgroup', io)
  if (mountinfo === undefined || selfCgroup === undefined) return { mode: 'none', reason: 'it has no /proc' }
  const mount = cgroupMount(mountinfo, selfCgroup)
  if (mount === undefined) return { mode: 'none', reason: 'it has no cgroup v2 mount' }
  const candidates: [string, boolean][] = []
  // This host's own cgroup first, where a delegated slice may create children.
  if (mount.self !== undefined) candidates.push([mount.self, true])
  if (mount.self !== mount.mount) candidates.push([mount.mount, false])
  return detectCpuQuota(candidates, io)
}

// Where cgroup v2 is mounted and this process's own cgroup below it. The mount
// point is wherever it was mounted, and mountinfo escapes spaces in octal.
export function cgroupMount(mountinfo: string, selfCgroup: string): { mount: string, self?: string } | undefined {
  const mounts = mountinfo.split('\n').flatMap((line) => {
    const [fields, after] = line.split(' - ')
    const point = fields?.split(' ')[4]
    return after?.startsWith('cgroup2 ') && point ? [unescape(point)] : []
  })
  if (!mounts.length) return undefined
  const path = selfCgroup.split('\n').map((line) => /^\d+:[^:]*:(.*)$/.exec(line)?.[1]).find((p) => p !== undefined)
  const mount = path === undefined
    ? mounts[0]!
    : mounts.find((m) => path === m || path.startsWith(`${m.replace(/\/+$/, '')}/`)) ?? mounts[0]!
  if (path === undefined) return { mount }
  return { mount, self: `${mount}/${path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1') }
}

function unescape(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)))
}

// The first base whose children can be given a quota wins. `delegate` is false
// for a mount this process has no cgroup of its own in.
export function detectCpuQuota(candidates: [string, boolean][], io: CgroupIo): CpuQuota {
  let reason: string | undefined
  for (const [base, delegate] of candidates) {
    const problem = baseProblem(base, delegate, io)
    if (problem === undefined) return { mode: 'cgroup', base }
    // This process's own cgroup says more about why than the mount above it.
    reason ??= problem
  }
  return { mode: 'none', reason: reason ?? 'it has no cgroup v2' }
}

function baseProblem(base: string, delegate: boolean, io: CgroupIo): string | undefined {
  let controllers: string
  try {
    controllers = io.read(join(base, 'cgroup.controllers'))
  } catch (err) {
    return `its cgroup v2 is not readable (${messageOf(err)})`
  }
  if (!controllers.split(/\s+/).includes('cpu')) return 'its cgroup v2 has no cpu controller'
  const probe = join(base, 'hobwork-probe')
  try {
    io.mkdir(probe)
  } catch (err) {
    return `it cannot create a cgroup (${messageOf(err)})`
  }
  try {
    const problem = cpuMaxProblem(probe, io)
    if (problem === undefined) return undefined
    // A cgroup hands the cpu controller to its children only once asked, and the
    // kernel refuses to do that while it holds processes itself. The root cgroup
    // is exempt, so a delegated slice parks this process in a child first.
    const enabled = delegate ? parkSelf(base, io) : tryWrite(join(base, 'cgroup.subtree_control'), '+cpu', io)
    if (!enabled) return `it cannot set a cgroup CPU quota (${problem})`
    const retry = cpuMaxProblem(probe, io)
    return retry === undefined ? undefined : `it cannot set a cgroup CPU quota (${retry})`
  } finally {
    try {
      io.remove(probe)
    } catch {}
  }
}

function cpuMaxProblem(dir: string, io: CgroupIo): string | undefined {
  try {
    io.write(join(dir, 'cpu.max'), `${Math.round(0.01 * PERIOD_US)} ${PERIOD_US}`)
    return undefined
  } catch (err) {
    return messageOf(err)
  }
}

function parkSelf(base: string, io: CgroupIo): boolean {
  try {
    const park = join(base, 'host')
    io.mkdir(park)
    io.write(join(park, 'cgroup.procs'), String(process.pid))
    io.write(join(base, 'cgroup.subtree_control'), '+cpu')
    return true
  } catch {
    return false
  }
}

function tryWrite(path: string, value: string, io: CgroupIo): boolean {
  try {
    io.write(path, value)
    return true
  } catch {
    return false
  }
}

// The reason a VM cannot be held to `cpus`, or undefined when it can.
export function cpuShareProblem(cpus: number, quota: CpuQuota = cpuQuota()): string | undefined {
  if (Number.isInteger(cpus) || quota.mode === 'cgroup') return undefined
  return `this host cannot cap a VM at ${cpus} vCPUs, because ${quota.reason}. Ask for a whole number of vCPUs, at least 1.`
}

export function assertCpuShare(cpus: number, where: string, quota: CpuQuota = cpuQuota()): void {
  const problem = cpuShareProblem(cpus, quota)
  if (problem) throw new Error(`${where}: ${problem}`)
}

export type CpuCap = { readonly dir: string, release(): Promise<void> }

// Holds QEMU and every process below it to `cpus` of a core, and resolves only
// once they are all inside the cgroup, so the share is in force and not just
// written down. Removing it afterwards is the caller's job, when QEMU is gone.
export async function capVmCpu(quota: CpuQuota, pid: number, cpus: number, io: CgroupIo = realIo): Promise<CpuCap> {
  if (quota.mode !== 'cgroup') throw new Error(`this host cannot cap the VM at ${cpus} vCPUs, because ${quota.reason}`)
  const dir = join(quota.base, `vm-${pid}`)
  try {
    io.mkdir(dir)
    io.write(join(dir, 'cpu.max'), `${Math.max(1000, Math.round(cpus * PERIOD_US))} ${PERIOD_US}`)
  } catch (err) {
    await releaseCgroup(dir, io)
    throw new Error(`this host cannot cap the VM at ${cpus} vCPUs (${messageOf(err)})`)
  }
  const left = await moveInto(pid, dir, io)
  if (left.length) {
    await releaseCgroup(dir, io)
    throw new Error(
      `could not hold the VM to ${cpus} vCPUs: ${left.length} of its processes stayed outside its cgroup (${left.join(', ')})`,
    )
  }
  return { dir, release: () => releaseCgroup(dir, io) }
}

async function moveInto(pid: number, dir: string, io: CgroupIo): Promise<number[]> {
  const procs = join(dir, 'cgroup.procs')
  let left: number[] = []
  for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt++) {
    for (const p of io.tree(pid)) {
      // A process that exits while it is being moved is not one that escaped.
      try {
        io.write(procs, String(p))
      } catch {}
    }
    const moved = new Set(io.read(procs).split('\n').filter(Boolean))
    left = io.tree(pid).filter((p) => !moved.has(String(p)))
    if (!left.length) return []
    await sleep(MOVE_RETRY_MS)
  }
  return left
}

async function releaseCgroup(dir: string, io: CgroupIo): Promise<void> {
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
    try {
      io.remove(dir)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    }
    await sleep(RELEASE_RETRY_MS)
  }
  console.warn(`The cgroup of a VM stayed behind at ${dir}.`)
}

// QEMU's threads are not processes, and they go wherever the process that owns
// them goes.
function processTree(pid: number): number[] {
  const pids = [pid]
  for (const p of pids) {
    for (const task of directories(`/proc/${p}/task`)) {
      for (const child of tryRead(`/proc/${p}/task/${task}/children`)?.split(' ') ?? []) {
        if (child) pids.push(Number(child))
      }
    }
  }
  return pids
}

function directories(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function tryRead(path: string, io: CgroupIo = realIo): string | undefined {
  try {
    return io.read(path)
  } catch {
    return undefined
  }
}

function messageOf(err: unknown): string {
  return (err as Error).message
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
