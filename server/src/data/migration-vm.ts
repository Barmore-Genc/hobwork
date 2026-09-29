import { resolve } from 'node:path'
import type { GuestVmOptions } from '../guest-vm.ts'
import type { Sandbox } from '../sandbox/sandbox.ts'

const GUEST_DIR = '/migrate'
const RUNNER_DIR = '/opt/hobwork/db'
const HOST_RUNNER_DIR = resolve(import.meta.dirname, '../../../packages/sdk/src/db')

export type MigrationRun = { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

// Runs the migration runner in a VM with `dir` (holding input.json and
// db.sqlite) mounted read-write at /migrate. The VM has no network and is
// stopped before this returns, so the host only reads `dir` afterwards.
export type RunMigrationVm = (options: { dir: string; timeoutMs: number }) => Promise<MigrationRun>

export function migrationVmBackend(options: GuestVmOptions): RunMigrationVm {
  return async ({ dir, timeoutMs }) => {
    const sandbox: Sandbox = await options.createSandbox({
      image: options.image,
      memory: '1G',
      cpus: 2,
      mounts: {
        [GUEST_DIR]: { hostPath: dir },
        [RUNNER_DIR]: { hostPath: HOST_RUNNER_DIR, readonly: true },
      },
      egress: [],
      label: 'migrations',
    })
    try {
      const result = await sandbox.exec(`node --disable-warning=ExperimentalWarning ${RUNNER_DIR}/migrate-main.ts`, { timeoutMs }).result
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }
    } finally {
      await sandbox.stop()
    }
  }
}
