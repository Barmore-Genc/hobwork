import { readFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import { priorityOf, systemClock, type Clock, type VmRequest } from './scheduler.ts'

// A VM the host may stop to give memory back. The sandbox factory registers one
// per running VM, so the killer sees the same requests the scheduler holds.
export type OomVictim = Readonly<VmRequest> & {
  // Stops the VM. Resolves once it is gone.
  stop(): Promise<void>
}

export type OomKillerOptions = {
  // Memory the host can hand out without reclaiming anything, or undefined on a
  // host that cannot say.
  availableMb(): number | undefined
  // Free memory the host keeps for itself, which is where VMs start to go. 0
  // never stops one.
  headroomMb: number
  log(message: string): void
  intervalMs?: number
  // Stops the VM, resolving to whether it did. The host routes workspace VMs
  // through its workspace manager, which closes their branch DB.
  stop?(victim: OomVictim): Promise<boolean>
  clock?: Clock
}

const CHECK_INTERVAL_MS = 5_000

// Stops VMs when the host runs out of memory, before the kernel's own OOM
// killer picks a process. The kernel scores processes by size, so it picks
// whatever is biggest, which can be the host itself; it also cannot know which
// of the VMs is the one to lose.
export function createOomKiller(options: OomKillerOptions) {
  const clock = options.clock ?? systemClock
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS
  const stop = options.stop ?? ((victim: OomVictim) => victim.stop().then(() => true, () => false))
  const victims = new Set<OomVictim>()
  let cancel: (() => void) | undefined
  let reportedNothingLeft = false

  // Workspaces go first: one comes back with the next command, while a runtime
  // VM takes its hob's UI and handlers down with it. Among equals the VM that
  // reserved the most memory goes first, since it frees the most.
  function ranked(): OomVictim[] {
    return [...victims].sort((a, b) => priorityOf(b.kind) - priorityOf(a.kind) || b.memoryMb - a.memoryMb)
  }

  async function check(): Promise<void> {
    const headroomMb = options.headroomMb
    const free = options.availableMb()
    if (free === undefined) return
    if (free >= headroomMb) {
      reportedNothingLeft = false
      return
    }
    let current = free
    for (const victim of ranked()) {
      if (!(await stop(victim))) continue
      options.log(
        `The host had ${current}MB free, below the ${headroomMb}MB it keeps for itself, so the ${describe(victim)} was stopped.`,
      )
      const after = options.availableMb()
      if (after === undefined || after >= headroomMb) {
        reportedNothingLeft = false
        return
      }
      current = after
    }
    if (!reportedNothingLeft) {
      reportedNothingLeft = true
      options.log(`The host has ${current}MB free with no VM left to stop, so the rest is up to the kernel's OOM killer.`)
    }
  }

  function schedule(): void {
    cancel = clock.setTimeout(() => {
      cancel = undefined
      void check().finally(schedule)
    }, intervalMs)
  }

  return {
    // Resolves once the VM is out of the killer's reach.
    watch(victim: OomVictim): () => void {
      victims.add(victim)
      return () => {
        victims.delete(victim)
      }
    },
    check,
    start(): void {
      if (!cancel) schedule()
    },
  }
}

export type OomKiller = ReturnType<typeof createOomKiller>

function describe(victim: OomVictim): string {
  return `${victim.kind} VM of ${victim.project}${victim.branch === undefined ? '' : `/${victim.branch}`}`
}

// What the kernel can hand out without swapping, which already counts what it
// can reclaim (page cache) and what it keeps in reserve.
export function hostAvailableMb(
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => string | undefined = readText,
): number | undefined {
  if (platform !== 'linux') return undefined
  const kilobytes = /^MemAvailable:\s+(\d+) kB$/m.exec(read('/proc/meminfo') ?? '')?.[1]
  return kilobytes === undefined ? undefined : Math.floor(Number(kilobytes) / 1024)
}

const DEFAULT_HEADROOM_MIN_MB = 512
const DEFAULT_HEADROOM_MAX_MB = 2048

// Free memory the host keeps for itself before it stops VMs: a sixteenth of its
// memory, between 512MB and 2GB. Below that the kernel is reclaiming everything
// it can, and the next big allocation comes out of something the host needs.
//
// A VM comes back from being stopped, most of them within seconds, so this is a
// smaller loss than the kernel killing the host's server. 0 turns it off.
export function loadOomHeadroom(
  env: NodeJS.ProcessEnv = process.env,
  totalMemoryMb: number = Math.floor(totalmem() / 1024 / 1024),
): number {
  const value = env.HOBWORK_VM_MEMORY_HEADROOM_MB
  if (value === undefined) return Math.min(Math.max(DEFAULT_HEADROOM_MIN_MB, Math.floor(totalMemoryMb / 16)), DEFAULT_HEADROOM_MAX_MB)
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`HOBWORK_VM_MEMORY_HEADROOM_MB must be a whole number of megabytes, or 0 to never stop a VM for memory, got "${value}"`)
  }
  return number
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
