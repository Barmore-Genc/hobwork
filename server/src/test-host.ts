import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHostDb } from './db.ts'
import type { Host } from './host.ts'

export function createTestHost(): Host & { dispose(): void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'hobwork-test-'))
  const db = openHostDb(':memory:')
  return {
    db,
    dataDir,
    dispose() {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
