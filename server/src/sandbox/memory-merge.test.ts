import { expect, test } from 'vitest'
import { memoryMergeEnabled, memoryMergeNotice } from './memory-merge.ts'

test('memory merging is on unless it is turned off', () => {
  expect(memoryMergeEnabled({})).toBe(true)
  expect(memoryMergeEnabled({ HOBWORK_VM_MEMORY_MERGE: '1' })).toBe(true)
  expect(memoryMergeEnabled({ HOBWORK_VM_MEMORY_MERGE: '0' })).toBe(false)
})

test('says nothing when the sharing is on', () => {
  expect(memoryMergeNotice({}, 'linux', () => '1\n')).toBeUndefined()
})

test('says how to turn the sharing on', () => {
  expect(memoryMergeNotice({}, 'linux', () => '0\n')).toContain('echo 1 > /sys/kernel/mm/ksm/run')
})

test('says when the kernel has no KSM to turn on', () => {
  expect(memoryMergeNotice({}, 'linux', () => undefined)).toContain('no KSM')
})

test('says nothing when merging is off or the host is not Linux', () => {
  expect(memoryMergeNotice({ HOBWORK_VM_MEMORY_MERGE: '0' }, 'linux', () => '0\n')).toBeUndefined()
  expect(memoryMergeNotice({}, 'darwin', () => '0\n')).toBeUndefined()
})
