import { resolve } from 'node:path'
import type { GuestVmOptions } from '../guest-vm.ts'
import type { Sandbox } from '../sandbox/sandbox.ts'

const GUEST_DIR = '/migrate'
const RUNNER_DIR = '/opt/hobwork/db'
const HOST_RUNNER_DIR = resolve(import.meta.dirname, '../../../packages/sdk/src/db')

export type MigrationRun = { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

// Runs the migration runner in a VM with `dir` (holding input.json and
// db.sqlite) mounted read-write at /migrate. The VM has no network and is
// stopped before this returns, so the host only reads `dir` afterwards. Writes
// past `quotaBytes` fail inside the VM, so a migration cannot fill the host's
// disk. `project` is the hob the migration is for, for the VM budget.
export type RunMigrationVm = (options: { project: string; dir: string; timeoutMs: number; quotaBytes: number }) => Promise<MigrationRun>

export function migrationVmBackend(options: GuestVmOptions): RunMigrationVm {
  return async ({ project, dir, timeoutMs, quotaBytes }) => {
    const sandbox: Sandbox = await options.createSandbox({
      image: options.image,
      budget: { kind: 'pipeline', project },
      memory: '1G',
      cpus: 2,
      mounts: {
        [GUEST_DIR]: { hostPath: dir, maxBytes: quotaBytes },
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
