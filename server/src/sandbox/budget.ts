import { cpus, totalmem } from 'node:os'
import type { Sandbox, SandboxFactory } from './sandbox.ts'
import type { VmScheduler } from './scheduler.ts'

export type ResourceKind = 'runtime' | 'workspace' | 'pipeline'
export type Resources = { memoryMb: number; cpus: number }
// What hobwork.json may ask for. Either field can be left out.
export type ResourceRequest = Partial<Record<ResourceKind, Partial<Resources>>>

// Branch previews use the runtime's, builds the pipeline's.
export const DEFAULT_RESOURCES: Record<ResourceKind, Resources> = {
  runtime: { memoryMb: 512, cpus: 2 },
  workspace: { memoryMb: 2048, cpus: 4 },
  pipeline: { memoryMb: 2048, cpus: 4 },
}

// A hob can ask for less than the default and never for more.
export function resolveResources(
  kind: ResourceKind,
  requested: ResourceRequest | undefined,
  defaults: Resources = DEFAULT_RESOURCES[kind],
): Resources {
  const ask = requested?.[kind]
  return {
    memoryMb: Math.min(defaults.memoryMb, ask?.memoryMb ?? defaults.memoryMb),
    cpus: Math.min(defaults.cpus, ask?.cpus ?? defaults.cpus),
  }
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
  const biggest = Object.values(DEFAULT_RESOURCES)
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
// it stops, exits or fails to boot.
export function budgetedSandboxFactory(create: SandboxFactory, scheduler: VmScheduler): SandboxFactory {
  return async (options) => {
    const { kind = 'pipeline', project = '(host)', branch } = options.budget ?? {}
    const lease = await scheduler.acquire({
      kind,
      project,
      branch,
      memoryMb: memoryMbOf(options.memory ?? '1G'),
      cpus: options.cpus ?? 2,
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
