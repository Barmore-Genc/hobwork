import { expect, test } from 'vitest'
import { budgetedSandboxFactory, DEFAULT_RESOURCES, loadVmBudget, memoryMbOf, resolveResources } from './budget.ts'
import type { Sandbox } from './sandbox.ts'
import { createVmScheduler } from './scheduler.ts'

test('a hob can ask for less than the defaults, never more', () => {
  expect(resolveResources('workspace', undefined)).toEqual(DEFAULT_RESOURCES.workspace)
  expect(resolveResources('workspace', { workspace: { memoryMb: 1024 } })).toEqual({ memoryMb: 1024, cpus: 4 })
  expect(resolveResources('runtime', { runtime: { memoryMb: 8192, cpus: 16 } })).toEqual(DEFAULT_RESOURCES.runtime)
  expect(resolveResources('runtime', { workspace: { cpus: 1 } })).toEqual(DEFAULT_RESOURCES.runtime)
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
  expect(loadVmBudget({}, { totalMemoryMb: 2048, cpuCount: 1 })).toMatchObject({ memoryMb: 2048, cpus: 4 })
})

function fakeSandbox(): Sandbox {
  return { id: 'vm', stop: async () => {} } as unknown as Sandbox
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
