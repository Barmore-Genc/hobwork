import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { VfsHookContext, VfsHooks } from '@earendil-works/gondolin'

// Every entry counts at least this much, so a guest cannot exhaust the host's
// inodes with empty files and directories.
const ENTRY_COST = 4096

function usage(dir: string): number {
  let total = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    total += Math.max(ENTRY_COST, stat.size)
    if (stat.isDirectory()) total += usage(path)
  }
  return total
}

function sizeOf(path: string): number {
  try {
    return lstatSync(path).size
  } catch {
    return 0
  }
}

function isWriteOpen(flags: string | number | undefined): boolean {
  return typeof flags === 'string' && /[wax+]/.test(flags)
}

// Caps how much the guest can put in a mounted host directory. Gondolin has no
// mount quota, and a guest that fills the host's disk takes the host down with
// it. Counts logical sizes, so a sparse file costs its full length. Refuses
// with ENOSPC before the write reaches the disk.
export function mountQuota(hostPath: string, maxBytes: number): VfsHooks {
  return {
    before(context: VfsHookContext) {
      const growth = growthOf(hostPath, context)
      if (growth <= 0) return
      if (usage(hostPath) + growth > maxBytes) {
        throw Object.assign(new Error(`ENOSPC: no space left in the mount (limit ${maxBytes} bytes)`), { code: 'ENOSPC' })
      }
    },
  }
}

function growthOf(hostPath: string, { op, path = '', flags, offset, length = 0, size, data }: VfsHookContext): number {
  const file = join(hostPath, path)
  switch (op) {
    case 'write': {
      const current = sizeOf(file)
      return Math.max(0, (offset ?? current) + length - current)
    }
    case 'writeFile':
      return Math.max(0, (data?.length ?? 0) - sizeOf(file))
    case 'truncate':
      return Math.max(0, (size ?? 0) - sizeOf(file))
    case 'open':
      return isWriteOpen(flags) ? ENTRY_COST : 0
    case 'mkdir':
    case 'symlink':
    case 'link':
      return ENTRY_COST
    default:
      return 0
  }
}
