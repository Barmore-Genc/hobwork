import { expect, test } from 'vitest'
import { createOomKiller, hostAvailableMb, loadOomHeadroom, type OomVictim } from './oom.ts'
import type { VmKind } from './sandbox.ts'

const MEMINFO = [
  'MemTotal:       24000000 kB',
  'MemFree:          600000 kB',
  'MemAvailable:    1536000 kB',
  'Buffers:           10000 kB',
].join('\n')

test('reads the memory the kernel can hand out', () => {
  expect(hostAvailableMb('linux', () => MEMINFO)).toBe(1500)
  expect(hostAvailableMb('linux', () => 'MemFree: 600000 kB\n')).toBeUndefined()
  expect(hostAvailableMb('linux', () => undefined)).toBeUndefined()
  expect(hostAvailableMb('darwin', () => MEMINFO)).toBeUndefined()
})

test('keeps a sixteenth of the memory for the host, between 512MB and 2GB', () => {
  expect(loadOomHeadroom({}, 24_576)).toBe(1536)
  expect(loadOomHeadroom({}, 8192)).toBe(512)
  expect(loadOomHeadroom({}, 131_072)).toBe(2048)
  expect(loadOomHeadroom({ HOBWORK_VM_MEMORY_HEADROOM_MB: '300' }, 24_576)).toBe(300)
  expect(loadOomHeadroom({ HOBWORK_VM_MEMORY_HEADROOM_MB: '0' }, 24_576)).toBe(0)
  expect(() => loadOomHeadroom({ HOBWORK_VM_MEMORY_HEADROOM_MB: '-1' }, 24_576)).toThrow('HOBWORK_VM_MEMORY_HEADROOM_MB')
  expect(() => loadOomHeadroom({ HOBWORK_VM_MEMORY_HEADROOM_MB: 'some' }, 24_576)).toThrow('HOBWORK_VM_MEMORY_HEADROOM_MB')
})

// A host whose free memory goes up as VMs stop, since that is what the killer
// reads again after every one of them.
function machine(freeMb: number, headroomMb = 1024) {
  const state = { free: freeMb, log: [] as string[], stopped: [] as string[] }
  const killer = createOomKiller({
    availableMb: () => state.free,
    headroomMb,
    log: (message) => state.log.push(message),
  })
  // A stopped VM is gone, so it stops being a victim like an exited one.
  const watch = (kind: VmKind, project: string, memoryMb = 768, branch?: string) => {
    let unwatch = () => {}
    const victim: OomVictim = {
      kind,
      project,
      memoryMb,
      cpus: 2,
      ...(branch === undefined ? {} : { branch }),
      async stop() {
        state.stopped.push(`${kind} VM of ${project}${branch === undefined ? '' : `/${branch}`}`)
        state.free += memoryMb
        unwatch()
      },
    }
    unwatch = killer.watch(victim)
  }
  return { state, killer, watch }
}

test('stops nothing while the host has memory to spare', async () => {
  const { state, killer, watch } = machine(4096)
  watch('workspace', 'a', 768, 'main')
  await killer.check()
  expect(state.stopped).toEqual([])
  expect(state.log).toEqual([])
})

test('stops a workspace VM before a runtime one', async () => {
  const { state, killer, watch } = machine(100, 512)
  watch('runtime', 'a')
  watch('workspace', 'a')
  watch('preview', 'a')
  await killer.check()
  expect(state.stopped).toEqual(['workspace VM of a'])
  expect(state.log).toEqual([
    'The host had 100MB free, below the 512MB it keeps for itself, so the workspace VM of a was stopped.',
  ])
})

test('stops the VM that frees the most memory first among equals', async () => {
  const { state, killer, watch } = machine(100)
  watch('workspace', 'small', 512, 'main')
  watch('workspace', 'big', 1024, 'main')
  await killer.check()
  expect(state.stopped).toEqual(['workspace VM of big/main'])
})

test('stops VMs until the host has its headroom back', async () => {
  const { state, killer, watch } = machine(100)
  watch('runtime', 'a', 300)
  watch('workspace', 'a', 300, 'one')
  watch('workspace', 'a', 300, 'two')
  watch('workspace', 'a', 300, 'three')
  await killer.check()
  expect(state.stopped).toEqual(['workspace VM of a/one', 'workspace VM of a/two', 'workspace VM of a/three', 'runtime VM of a'])
  expect(state.free).toBe(1300)
})

test('says once when there is no VM left to stop', async () => {
  const { state, killer, watch } = machine(100)
  watch('workspace', 'a', 100)
  await killer.check()
  await killer.check()
  expect(state.stopped).toEqual(['workspace VM of a'])
  expect(state.log).toEqual([
    'The host had 100MB free, below the 1024MB it keeps for itself, so the workspace VM of a was stopped.',
    'The host has 200MB free with no VM left to stop, so the rest is up to the kernel\'s OOM killer.',
  ])
  // Once the host has its memory back, the next shortage is a new thing to report.
  state.free = 4096
  await killer.check()
  state.free = 100
  await killer.check()
  expect(state.log).toHaveLength(3)
})

test('a VM whose stop fails does not count as stopped', async () => {
  const log: string[] = []
  const stopped: string[] = []
  const killer = createOomKiller({
    availableMb: () => 100,
    headroomMb: 1024,
    log: (message) => log.push(message),
    stop: async (victim) => {
      if (victim.project === 'broken') return false
      stopped.push(victim.project)
      return true
    },
  })
  const victim = (project: string): OomVictim => ({
    kind: 'workspace',
    project,
    branch: 'main',
    memoryMb: 1024,
    cpus: 2,
    stop: async () => {},
  })
  killer.watch(victim('broken'))
  killer.watch(victim('fine'))
  await killer.check()
  expect(stopped).toEqual(['fine'])
  expect(log[0]).toContain('so the workspace VM of fine/main was stopped.')
})

test('a VM that is gone is no longer a victim', async () => {
  const { state, killer } = machine(100)
  const unwatch = killer.watch({ kind: 'workspace', project: 'a', branch: 'main', memoryMb: 1024, cpus: 2, stop: async () => {} })
  unwatch()
  await killer.check()
  expect(state.stopped).toEqual([])
})

test('checks again on its own until it is stopped', async () => {
  const timers: (() => void)[] = []
  let free = 100
  const killed: string[] = []
  const killer = createOomKiller({
    availableMb: () => free,
    headroomMb: 1024,
    log: () => {},
    clock: { now: () => 0, setTimeout: (callback) => (timers.push(callback), () => {}) },
  })
  killer.watch({
    kind: 'workspace',
    project: 'a',
    memoryMb: 1024,
    cpus: 2,
    stop: async () => {
      killed.push('a')
      free = 4096
    },
  })
  killer.start()
  expect(timers).toHaveLength(1)
  timers.shift()!()
  await expect.poll(() => killed).toEqual(['a'])
  expect(timers).toHaveLength(1)
})
