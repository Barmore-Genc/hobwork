import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mountQuota } from './quota.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobwork-quota-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function check(quota: ReturnType<typeof mountQuota>, context: Parameters<NonNullable<ReturnType<typeof mountQuota>['before']>>[0]) {
  return () => quota.before!(context)
}

test('allows writes that stay under the limit and refuses the rest with ENOSPC', () => {
  writeFileSync(join(dir, 'db.sqlite'), Buffer.alloc(10_000))
  const quota = mountQuota(dir, 20_000)
  expect(check(quota, { op: 'write', path: '/db.sqlite', offset: 0, length: 4096 })).not.toThrow()
  expect(check(quota, { op: 'write', path: '/db.sqlite', offset: 10_000, length: 4096 })).not.toThrow()
  expect(check(quota, { op: 'write', path: '/db.sqlite', offset: 10_000, length: 12_000 })).toThrowError(
    expect.objectContaining({ code: 'ENOSPC' }),
  )
})

test('counts appends, truncates and sparse writes by their logical size', () => {
  writeFileSync(join(dir, 'a'), Buffer.alloc(1000))
  const quota = mountQuota(dir, 20_000)
  expect(check(quota, { op: 'write', path: '/a', length: 30_000 })).toThrow('ENOSPC')
  expect(check(quota, { op: 'truncate', path: '/a', size: 1_000_000_000 })).toThrow('ENOSPC')
  expect(check(quota, { op: 'write', path: '/a', offset: 1_000_000_000, length: 1 })).toThrow('ENOSPC')
  expect(check(quota, { op: 'truncate', path: '/a', size: 10 })).not.toThrow()
})

test('counts files already in nested directories', () => {
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'big'), Buffer.alloc(1))
  truncateSync(join(dir, 'sub', 'big'), 15_000)
  const quota = mountQuota(dir, 20_000)
  expect(check(quota, { op: 'write', path: '/new', offset: 0, length: 10_000 })).toThrow('ENOSPC')
})

test('many empty entries run into the limit too', () => {
  const quota = mountQuota(dir, 10_000)
  for (let i = 0; i < 2; i++) {
    expect(check(quota, { op: 'open', path: `/f${i}`, flags: 'w' })).not.toThrow()
    writeFileSync(join(dir, `f${i}`), '')
  }
  expect(check(quota, { op: 'open', path: '/f3', flags: 'w' })).toThrow('ENOSPC')
  expect(check(quota, { op: 'mkdir', path: '/d' })).toThrow('ENOSPC')
  expect(check(quota, { op: 'open', path: '/f0', flags: 'r' })).not.toThrow()
})
