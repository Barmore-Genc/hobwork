import { expect, test } from 'vitest'
import { createVmScheduler, HostBusyError, type Clock, type Lease, type VmRequest } from './scheduler.ts'

function fakeClock() {
  let time = 0
  const timers = new Set<{ at: number; callback: () => void }>()
  const clock: Clock = {
    now: () => time,
    setTimeout(callback, ms) {
      const timer = { at: time + ms, callback }
      timers.add(timer)
      return () => timers.delete(timer)
    },
  }
  return {
    clock,
    async advance(ms: number) {
      const end = time + ms
      for (;;) {
        const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers.delete(next)
        time = next.at
        next.callback()
        await Promise.resolve()
      }
      time = end
      await Promise.resolve()
    },
  }
}

const vm = (kind: VmRequest['kind'], project: string, memoryMb = 1000, extra: Partial<VmRequest> = {}): VmRequest => ({
  kind,
  project,
  memoryMb,
  cpus: 1,
  ...extra,
})

function setup(options: { memoryMb?: number; reclaim?: (request: Readonly<VmRequest>) => Promise<boolean> } = {}) {
  const time = fakeClock()
  const scheduler = createVmScheduler({
    memoryMb: options.memoryMb ?? 3000,
    cpus: 100,
    waitMs: 60_000,
    retryMs: 5_000,
    clock: time.clock,
    reclaim: options.reclaim,
  })
  const granted: string[] = []
  const acquire = (request: VmRequest, label: string) => {
    const promise = scheduler.acquire(request)
    promise.then(
      () => granted.push(label),
      () => {},
    )
    return promise
  }
  return { ...time, scheduler, granted, acquire }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('grants requests that fit at once, borrowing capacity regardless of share', async () => {
  const { acquire, granted } = setup()
  await acquire(vm('workspace', 'a'), 'a1')
  await acquire(vm('workspace', 'a'), 'a2')
  await acquire(vm('workspace', 'a'), 'a3')
  expect(granted).toEqual(['a1', 'a2', 'a3'])
})

test('serves runtimes, then builds and previews, then workspaces', async () => {
  const { acquire, granted, scheduler } = setup()
  const first = await scheduler.acquire(vm('runtime', 'x', 3000))
  void acquire(vm('workspace', 'a'), 'workspace')
  void acquire(vm('build', 'b'), 'build')
  void acquire(vm('runtime', 'c'), 'runtime')
  void acquire(vm('preview', 'd'), 'preview')
  await settle()
  expect(granted).toEqual([])
  first.release()
  await settle()
  expect(granted).toEqual(['runtime', 'build', 'preview'])
})

test('shares equally between hobs that queue', async () => {
  const { acquire, granted, scheduler } = setup({ memoryMb: 2000 })
  const held = await Promise.all([scheduler.acquire(vm('workspace', 'greedy')), scheduler.acquire(vm('workspace', 'greedy'))])
  void acquire(vm('workspace', 'greedy'), 'greedy 3')
  void acquire(vm('workspace', 'greedy'), 'greedy 4')
  void acquire(vm('workspace', 'small'), 'small 1')
  held[0]!.release()
  await settle()
  expect(granted).toEqual(['small 1'])
  held[1]!.release()
  await settle()
  expect(granted).toEqual(['small 1', 'greedy 3'])
})

test('a wait ends with a host busy error', async () => {
  const { scheduler, advance } = setup({ memoryMb: 1000 })
  await scheduler.acquire(vm('workspace', 'a'))
  const waiting = scheduler.acquire(vm('workspace', 'b'))
  const failure = waiting.catch((err: unknown) => err)
  await advance(60_000)
  const err = await failure
  expect(err).toBeInstanceOf(HostBusyError)
  expect((err as Error).message).toMatch(/Hobwork is busy.*Try again in a minute/)
  expect(scheduler.snapshot().waiting).toBe(0)
})

test('rejects a request bigger than the whole budget at once', async () => {
  const { scheduler } = setup({ memoryMb: 1000 })
  await expect(scheduler.acquire(vm('workspace', 'a', 2000))).rejects.toBeInstanceOf(HostBusyError)
})

test('stops idle workspaces for a runtime, the hob furthest over its share first', async () => {
  const stopped: string[] = []
  const leases = new Map<string, Lease>()
  const { scheduler, granted, acquire } = setup({
    memoryMb: 3000,
    reclaim: async (request) => {
      const key = `${request.project}/${request.branch}`
      stopped.push(key)
      leases.get(key)?.release()
      return true
    },
  })
  for (const [project, branch] of [['big', '1'], ['big', '2'], ['small', '1']] as const) {
    leases.set(`${project}/${branch}`, await scheduler.acquire(vm('workspace', project, 1000, { branch })))
  }
  void acquire(vm('runtime', 'other', 1000), 'runtime')
  await settle()
  expect(stopped).toEqual(['big/1'])
  expect(granted).toContain('runtime')
})

test('a workspace only takes room from hobs over their share', async () => {
  const stopped: string[] = []
  const leases = new Map<string, Lease>()
  const { scheduler, granted, acquire } = setup({
    memoryMb: 3000,
    reclaim: async (request) => {
      stopped.push(`${request.project}/${request.branch}`)
      leases.get(`${request.project}/${request.branch}`)?.release()
      return true
    },
  })
  for (const [project, branch] of [['big', '1'], ['big', '2'], ['mid', '1']] as const) {
    leases.set(`${project}/${branch}`, await scheduler.acquire(vm('workspace', project, 1000, { branch })))
  }
  void acquire(vm('workspace', 'new'), 'new')
  await settle()
  expect(stopped).toEqual(['big/1'])
  expect(granted).toEqual(['new'])

  // A fourth active hob lowers everyone's share, so the hob with the most gives up another VM.
  void acquire(vm('workspace', 'late'), 'late')
  await settle()
  expect(stopped).toEqual(['big/1', 'big/2'])
  expect(granted).toEqual(['new', 'late'])
})

test('looks again for idle workspaces when a stop was refused', async () => {
  let idle = false
  const stopped: string[] = []
  let lease: Lease | undefined
  const { scheduler, granted, acquire, advance } = setup({
    memoryMb: 1000,
    reclaim: async () => {
      if (!idle) return false
      stopped.push('ws')
      lease?.release()
      return true
    },
  })
  lease = await scheduler.acquire(vm('workspace', 'a', 1000, { branch: 'x' }))
  void acquire(vm('runtime', 'b'), 'runtime')
  await settle()
  expect(granted).toEqual([])
  idle = true
  await advance(5_000)
  await settle()
  expect(stopped).toEqual(['ws'])
  expect(granted).toEqual(['runtime'])
})

test('releasing twice frees the resources once', async () => {
  const { scheduler } = setup({ memoryMb: 2000 })
  const lease = await scheduler.acquire(vm('workspace', 'a'))
  await scheduler.acquire(vm('workspace', 'a'))
  lease.release()
  lease.release()
  expect(scheduler.snapshot().used.memoryMb).toBe(1000)
})
