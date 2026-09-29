import type { VmKind } from './sandbox.ts'

export class HostBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostBusyError'
  }
}

// Lower runs first: the main runtime, then builds, previews and pipeline runs,
// then workspaces.
export function priorityOf(kind: VmKind): number {
  if (kind === 'runtime') return 0
  return kind === 'workspace' ? 2 : 1
}

export type VmRequest = {
  kind: VmKind
  project: string
  // Set for workspaces, to tell which one to stop.
  branch?: string
  memoryMb: number
  cpus: number
}

export type Lease = Readonly<VmRequest> & {
  // Gives the resources back. Calling it again does nothing.
  release(): void
}

export type Clock = {
  now(): number
  setTimeout(callback: () => void, ms: number): () => void
}

export type SchedulerOptions = {
  memoryMb: number
  cpus: number
  // How long a request waits before it fails with HostBusyError.
  waitMs: number
  // How often a blocked request looks again for workspace VMs that went idle.
  retryMs?: number
  // Stops the workspace VM of the lease if nothing is running in it. Resolves
  // to whether it did; a stopped VM gives its lease back by itself.
  reclaim?: (lease: Readonly<VmRequest>) => Promise<boolean>
  clock?: Clock
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms)
    timer.unref()
    return () => clearTimeout(timer)
  },
}

type Held = { request: VmRequest; lease: Lease; reclaiming: boolean; reclaimFailedAt: number }
type Waiter = {
  request: VmRequest
  priority: number
  seq: number
  grant: (lease: Lease) => void
  cancelTimer: () => void
}

// Reserves memory and vCPUs for VMs from a fixed budget.
//
// A request that fits is granted at once, whoever else is waiting for other
// hobs: idle capacity can be borrowed. When the budget is full, requests wait in
// one queue per hob. The next one to run is the one with the best priority, and
// among equals the hob using the least memory, so every active hob gets an equal
// share over time. For the request that is next, idle workspace VMs are stopped
// to make room: any of them for a runtime, build or preview, and only those of
// other hobs that are over their equal share for a workspace.
export function createVmScheduler(options: SchedulerOptions) {
  const clock = options.clock ?? realClock
  const retryMs = options.retryMs ?? 5_000
  const held = new Set<Held>()
  const queues = new Map<string, Waiter[]>()
  let seq = 0
  let cancelRetry: (() => void) | undefined

  function used() {
    let memoryMb = 0
    let cpus = 0
    for (const { request } of held) {
      memoryMb += request.memoryMb
      cpus += request.cpus
    }
    return { memoryMb, cpus }
  }

  function usageOf(project: string): number {
    let memoryMb = 0
    for (const { request } of held) if (request.project === project) memoryMb += request.memoryMb
    return memoryMb
  }

  function activeProjects(): Set<string> {
    const projects = new Set(queues.keys())
    for (const { request } of held) projects.add(request.project)
    return projects
  }

  function fits(request: VmRequest, extraFree = { memoryMb: 0, cpus: 0 }): boolean {
    const now = used()
    return (
      now.memoryMb + request.memoryMb <= options.memoryMb + extraFree.memoryMb &&
      now.cpus + request.cpus <= options.cpus + extraFree.cpus
    )
  }

  function grant(waiter: Waiter) {
    const queue = queues.get(waiter.request.project) ?? []
    queue.splice(queue.indexOf(waiter), 1)
    if (!queue.length) queues.delete(waiter.request.project)
    waiter.cancelTimer()
    const entry: Held = {
      request: waiter.request,
      reclaiming: false,
      reclaimFailedAt: -Infinity,
      lease: undefined as unknown as Lease,
    }
    entry.lease = {
      ...waiter.request,
      release() {
        if (!held.delete(entry)) return
        pump()
      },
    }
    held.add(entry)
    waiter.grant(entry.lease)
  }

  // The first waiter of each hob's queue, ranked.
  function heads(): Waiter[] {
    const result: Waiter[] = []
    for (const queue of queues.values()) {
      const head = queue.reduce((best, w) => (w.priority < best.priority || (w.priority === best.priority && w.seq < best.seq) ? w : best))
      result.push(head)
    }
    return result.sort(
      (a, b) =>
        a.priority - b.priority ||
        usageOf(a.request.project) - usageOf(b.request.project) ||
        a.seq - b.seq,
    )
  }

  function reclaimCandidates(waiter: Waiter): Held[] {
    const share = options.memoryMb / Math.max(1, activeProjects().size)
    const now = clock.now()
    return [...held]
      .filter((entry) => {
        const { request } = entry
        if (request.kind !== 'workspace' || entry.reclaiming || now - entry.reclaimFailedAt < retryMs) return false
        if (waiter.priority < 2) return true
        return request.project !== waiter.request.project && usageOf(request.project) > share
      })
      .sort((a, b) => usageOf(b.request.project) - usageOf(a.request.project) || a.request.memoryMb - b.request.memoryMb)
  }

  function reclaimFor(waiter: Waiter) {
    const { reclaim } = options
    if (!reclaim) return
    const pending = { memoryMb: 0, cpus: 0 }
    for (const entry of held) {
      if (!entry.reclaiming) continue
      pending.memoryMb += entry.request.memoryMb
      pending.cpus += entry.request.cpus
    }
    for (const entry of reclaimCandidates(waiter)) {
      if (fits(waiter.request, pending)) return
      entry.reclaiming = true
      pending.memoryMb += entry.request.memoryMb
      pending.cpus += entry.request.cpus
      void reclaim(entry.request)
        .catch(() => false)
        .then((stopped) => {
          entry.reclaiming = false
          if (stopped) return
          entry.reclaimFailedAt = clock.now()
          pump()
        })
    }
  }

  function pump() {
    for (;;) {
      const next = heads()[0]
      if (!next) break
      if (!fits(next.request)) {
        reclaimFor(next)
        break
      }
      grant(next)
    }
    cancelRetry?.()
    cancelRetry = undefined
    if (queues.size) cancelRetry = clock.setTimeout(pump, retryMs)
  }

  function acquire(request: VmRequest): Promise<Lease> {
    if (request.memoryMb > options.memoryMb || request.cpus > options.cpus) {
      return Promise.reject(
        new HostBusyError(
          `A ${request.kind} VM needs ${request.memoryMb} MB and ${request.cpus} vCPUs, more than the whole VM budget of this host (${options.memoryMb} MB, ${options.cpus} vCPUs)`,
        ),
      )
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        request,
        priority: priorityOf(request.kind),
        seq: seq++,
        grant: resolve,
        cancelTimer: () => {},
      }
      waiter.cancelTimer = clock.setTimeout(() => {
        const queue = queues.get(request.project) ?? []
        queue.splice(queue.indexOf(waiter), 1)
        if (!queue.length) queues.delete(request.project)
        reject(
          new HostBusyError(
            `Hobwork is busy: there was no room to start a ${request.kind} VM for ${request.project}. Try again in a minute.`,
          ),
        )
        pump()
      }, options.waitMs)
      const queue = queues.get(request.project) ?? []
      queue.push(waiter)
      queues.set(request.project, queue)
      pump()
    })
  }

  return {
    acquire,
    snapshot() {
      return {
        capacity: { memoryMb: options.memoryMb, cpus: options.cpus },
        used: used(),
        waiting: [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
      }
    },
  }
}

export type VmScheduler = ReturnType<typeof createVmScheduler>
