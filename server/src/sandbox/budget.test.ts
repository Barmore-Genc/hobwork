import { expect, test, vi } from 'vitest'
import { budgetedSandboxFactory, defaultResources, loadVmBudget, memoryMbOf, resolveResources } from './budget.ts'
import { cpuQuota } from './cpu-quota.ts'
import type { Sandbox } from './sandbox.ts'
import { createVmScheduler } from './scheduler.ts'

test('a hob can ask for less than the defaults, never more', () => {
  expect(resolveResources('workspace', undefined)).toEqual(defaultResources().workspace)
  expect(resolveResources('workspace', { workspace: { memoryMb: 1024 } })).toEqual({ memoryMb: 1024, cpus: 2 })
  expect(resolveResources('runtime', { runtime: { memoryMb: 8192, cpus: 16 } })).toEqual(defaultResources().runtime)
  expect(resolveResources('runtime', { workspace: { cpus: 1 } })).toEqual(defaultResources().runtime)
})

test('the runtime gets half a core where the host can cap one and a whole one where it cannot', () => {
  const quota = cpuQuota()
  expect(defaultResources()).toEqual({
    runtime: { memoryMb: 384, cpus: quota.mode === 'cgroup' ? 0.5 : 1 },
    workspace: { memoryMb: 1536, cpus: 2 },
    pipeline: { memoryMb: 1536, cpus: 2 },
  })
})

test('a fraction is only allowed where the host can hold a VM to it', () => {
  const quota = cpuQuota()
  if (quota.mode === 'cgroup') {
    expect(resolveResources('runtime', { runtime: { cpus: 0.25 } })).toEqual({ memoryMb: 384, cpus: 0.25 })
  } else {
    expect(() => resolveResources('runtime', { runtime: { cpus: 0.25 } })).toThrow(
      'resources.runtime.cpus: this host cannot cap a VM at 0.25 vCPUs',
    )
  }
})

test('parses memory sizes', () => {
  expect(memoryMbOf('512M')).toBe(512)
  expect(memoryMbOf('2G')).toBe(2048)
  expect(() => memoryMbOf('lots')).toThrow('memory size')
})

test('derives the budget from the machine and takes env overrides', () => {
  const machine = { totalMemoryMb: 16_384, cpuCount: 8 }
  expect(loadVmBudget({}, machine)).toEqual({ memoryMb: 12_288, cpus: 16, waitMs: 60_000 })
  expect(
    loadVmBudget({ HOBWORK_VM_MEMORY_MB: '4096', HOBWORK_VM_CPUS: '6', HOBWORK_VM_WAIT_SECONDS: '5' }, machine),
  ).toEqual({ memoryMb: 4096, cpus: 6, waitMs: 5000 })
  expect(() => loadVmBudget({ HOBWORK_VM_CPUS: '0' }, machine)).toThrow('HOBWORK_VM_CPUS')
})

test('the default budget always fits the biggest VM', () => {
  expect(loadVmBudget({}, { totalMemoryMb: 2048, cpuCount: 1 })).toMatchObject({ memoryMb: 1536, cpus: 2 })
})

function fakeSandbox(exited: Promise<void> = new Promise(() => {})): Sandbox {
  return { id: 'vm', exited, stop: async () => {} } as unknown as Sandbox
}

test('reserves on create and releases on stop or a failed boot', async () => {
  const scheduler = createVmScheduler({ memoryMb: 4096, cpus: 8, waitMs: 1000 })
  const create = budgetedSandboxFactory(async (options) => {
    if (options.env?.FAIL) throw new Error('boot failed')
    return fakeSandbox()
  }, scheduler)
  const sandbox = await create({ image: 'x', memory: '2G', cpus: 4, budget: { kind: 'workspace', project: 'a' } })
  expect(scheduler.snapshot().used).toEqual({ memoryMb: 2048, cpus: 4 })
  await expect(create({ image: 'x', memory: '1G', env: { FAIL: '1' } })).rejects.toThrow('boot failed')
  expect(scheduler.snapshot().used).toEqual({ memoryMb: 2048, cpus: 4 })
  await sandbox.stop()
  expect(scheduler.snapshot().used).toEqual({ memoryMb: 0, cpus: 0 })
})

test('reserves a share of a core as that share', async () => {
  const scheduler = createVmScheduler({ memoryMb: 2048, cpus: 1, waitMs: 100 })
  const create = budgetedSandboxFactory(async () => fakeSandbox(), scheduler)
  const one = await create({ image: 'x', memory: '256M', cpus: 0.5, budget: { kind: 'runtime', project: 'a' } })
  expect(scheduler.snapshot().used).toEqual({ memoryMb: 256, cpus: 0.5 })
  const two = await create({ image: 'x', memory: '256M', cpus: 0.5, budget: { kind: 'runtime', project: 'b' } })
  expect(scheduler.snapshot().used).toEqual({ memoryMb: 512, cpus: 1 })
  await expect(create({ image: 'x', memory: '256M', cpus: 0.5, budget: { kind: 'runtime', project: 'c' } })).rejects.toThrow('busy')
  await one.stop()
  await two.stop()
})

test('releases the reservation when the VM exits on its own', async () => {
  const scheduler = createVmScheduler({ memoryMb: 4096, cpus: 8, waitMs: 1000 })
  let exit: () => void = () => {}
  const exited = new Promise<void>((resolve) => (exit = resolve))
  const create = budgetedSandboxFactory(async (options) => fakeSandbox(options.env?.LIVE ? undefined : exited), scheduler)
  const sandbox = await create({ image: 'x', memory: '2G', cpus: 4 })
  expect(scheduler.snapshot().used).toEqual({ memoryMb: 2048, cpus: 4 })
  exit()
  await vi.waitFor(() => expect(scheduler.snapshot().used).toEqual({ memoryMb: 0, cpus: 0 }))
  const other = await create({ image: 'x', memory: '1G', cpus: 1, env: { LIVE: '1' } })
  await sandbox.stop()
  expect(scheduler.snapshot().used).toEqual({ memoryMb: 1024, cpus: 1 })
  await other.stop()
})
