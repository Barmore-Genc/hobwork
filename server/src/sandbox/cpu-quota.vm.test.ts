import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, test } from 'vitest'
import { cpuQuota } from './cpu-quota.ts'
import { createGondolinSandbox } from './gondolin.ts'
import { imageDir, imageExists } from './image.ts'
import type { Sandbox } from './sandbox.ts'

const quota = cpuQuota()

// Boots real VMs, so it only runs with HOBWORK_VM_TESTS=1 (`pnpm test:vm`), and
// only where the host can cap one. Everywhere else a share is refused before a
// VM starts, which `gondolin.test.ts` covers.
describe.runIf(process.env.HOBWORK_VM_TESTS === '1' && quota.mode === 'cgroup')(
  'fractional CPU shares',
  { timeout: 300_000 },
  () => {
    const started: Sandbox[] = []

    async function boot(cpus: number): Promise<Sandbox> {
      if (!imageExists(imageDir())) throw new Error(`no guest image at ${imageDir()}, run images/build.sh`)
      const sandbox = await createGondolinSandbox({ image: imageDir(), memory: '256M', cpus })
      started.push(sandbox)
      return sandbox
    }

    async function exec(sandbox: Sandbox, command: string): Promise<string> {
      const result = await sandbox.exec(command).result
      if (result.exitCode !== 0) throw new Error(`${command} exited with ${result.exitCode}: ${result.stderr}`)
      return result.stdout.trim()
    }

    const LOOP = 'node -e "let n = 0; for (let i = 0; i < 4e8; i++) n += i"'

    async function timeLoop(sandbox: Sandbox): Promise<number> {
      await exec(sandbox, 'node -e "let n = 0; for (let i = 0; i < 1e7; i++) n += i"')
      const started = Date.now()
      await exec(sandbox, LOOP)
      return Date.now() - started
    }

    afterAll(async () => {
      await Promise.all(started.map((sandbox) => sandbox.stop()))
    })

    test('holds QEMU and everything in the guest to the share', async () => {
      const half = await boot(0.5)
      const pid = half.hostPid()
      expect(pid).not.toBeNull()
      expect(readFileSync(`/proc/${pid}/cgroup`, 'utf8')).toContain(`/vm-${pid}`)
      const whole = await boot(2)
      // The same work takes about twice as long on half a core as on a whole one.
      const halfMs = await timeLoop(half)
      expect(halfMs).toBeGreaterThan((await timeLoop(whole)) * 1.4)
    }, 300_000)
  },
)
