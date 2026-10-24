import { cpus, totalmem } from 'node:os'
import { cpuQuota, cpuShareProblem, type CpuQuota } from './cpu-quota.ts'
import type { Sandbox, SandboxFactory } from './sandbox.ts'
import type { VmScheduler } from './scheduler.ts'

export type ResourceKind = 'runtime' | 'workspace' | 'pipeline'
export type Resources = { memoryMb: number; cpus: number }
// What hobwork.json may ask for. Either field can be left out.
export type ResourceRequest = Partial<Record<ResourceKind, Partial<Resources>>>

// Branch previews use the runtime's, builds the pipeline's.
//
// A handler serves one request at a time on one thread, so a runtime VM rarely
// needs a whole core. QEMU takes whole vCPUs, and only a host that can cap a
// VM's CPU time with cgroup v2 can give it a share of one (`cpu-quota.ts`), so
// other hosts get a whole vCPU there.
export function defaultResources(quota: CpuQuota = cpuQuota()): Record<ResourceKind, Resources> {
  return {
    runtime: { memoryMb: 384, cpus: quota.mode === 'cgroup' ? 0.5 : 1 },
    workspace: { memoryMb: 1536, cpus: 2 },
    pipeline: { memoryMb: 1536, cpus: 2 },
  }
}

// A hob can ask for less than the default and never for more. A fraction is
// only allowed where the host can hold the VM to it.
export function resolveResources(
  kind: ResourceKind,
  requested: ResourceRequest | undefined,
  defaults: Resources = defaultResources()[kind],
): Resources {
  const ask = requested?.[kind]
  const resources = {
    memoryMb: Math.min(defaults.memoryMb, ask?.memoryMb ?? defaults.memoryMb),
    cpus: Math.min(defaults.cpus, ask?.cpus ?? defaults.cpus),
  }
  const problem = cpuShareProblem(resources.cpus)
  if (problem) throw new Error(`resources.${kind}.cpus: ${problem}`)
  return resources
}

export function memoryMbOf(size: string): number {
  const match = /^(\d+)([MG])$/.exec(size)
  if (!match) throw new Error(`"${size}" is not a memory size like 512M or 2G`)
  return Number(match[1]) * (match[2] === 'G' ? 1024 : 1)
}

export function memorySize(memoryMb: number): string {
  return memoryMb % 1024 === 0 ? `${memoryMb / 1024}G` : `${memoryMb}M`
}

export type VmBudget = { memoryMb: number; cpus: number; waitMs: number }

const DEFAULT_WAIT_SECONDS = 60

function positiveInteger(name: string, value: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer, got "${value}"`)
  return number
}

// By default the host keeps a quarter of its memory (at least 1 GiB) for itself
// and the OS. vCPUs are overcommitted twice, since most VMs idle. The budget is
// never smaller than the biggest VM, or that VM could not start at all.
export function loadVmBudget(
  env: NodeJS.ProcessEnv,
  machine: { totalMemoryMb: number; cpuCount: number } = {
    totalMemoryMb: Math.floor(totalmem() / 1024 / 1024),
    cpuCount: cpus().length,
  },
): VmBudget {
  const biggest = Object.values(defaultResources())
  const headroomMb = Math.max(1024, machine.totalMemoryMb / 4)
  const memoryMb = env.HOBWORK_VM_MEMORY_MB
    ? positiveInteger('HOBWORK_VM_MEMORY_MB', env.HOBWORK_VM_MEMORY_MB)
    : Math.max(Math.floor(machine.totalMemoryMb - headroomMb), ...biggest.map((r) => r.memoryMb))
  const vcpus = env.HOBWORK_VM_CPUS
    ? positiveInteger('HOBWORK_VM_CPUS', env.HOBWORK_VM_CPUS)
    : Math.max(machine.cpuCount * 2, ...biggest.map((r) => r.cpus))
  const waitSeconds = env.HOBWORK_VM_WAIT_SECONDS
    ? positiveInteger('HOBWORK_VM_WAIT_SECONDS', env.HOBWORK_VM_WAIT_SECONDS)
    : DEFAULT_WAIT_SECONDS
  return { memoryMb, cpus: vcpus, waitMs: waitSeconds * 1000 }
}

// Reserves the VM's memory and vCPUs before it boots and gives them back when
// it stops, exits or fails to boot. A share of a core is reserved as that share,
// since the sandbox holds the VM to it.
export function budgetedSandboxFactory(create: SandboxFactory, scheduler: VmScheduler): SandboxFactory {
  return async (options) => {
    const { kind = 'pipeline', project = '(host)', branch } = options.budget ?? {}
    const cpus = options.cpus ?? 2
    const lease = await scheduler.acquire({
      kind,
      project,
      branch,
      memoryMb: memoryMbOf(options.memory ?? '1G'),
      cpus,
    })
    let sandbox: Sandbox
    try {
      sandbox = await create(options)
    } catch (err) {
      lease.release()
      throw err
    }
    // A VM that dies on its own would otherwise keep its share until someone calls stop().
    void sandbox.exited.then(() => lease.release())
    // Delegates by hand: the Gondolin sandbox has private fields, so its
    // methods must run with the real instance as `this`.
    return {
      get id() {
        return sandbox.id
      },
      exited: sandbox.exited,
      exec: (command, execOptions) => sandbox.exec(command, execOptions),
      spawn: (command, spawnOptions) => sandbox.spawn(command, spawnOptions),
      ingress: (port) => sandbox.ingress(port),
      readFile: (path) => sandbox.readFile(path),
      writeFile: (path, data) => sandbox.writeFile(path, data),
      hostPid: () => sandbox.hostPid(),
      async stop() {
        try {
          await sandbox.stop()
        } finally {
          lease.release()
        }
      },
    }
  }
}
