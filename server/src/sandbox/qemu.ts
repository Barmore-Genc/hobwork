import { join } from 'node:path'

const SANDBOXED_QEMU = join(import.meta.dirname, 'qemu-sandboxed.sh')

// Only Linux QEMU is built with seccomp, so macOS dev runs plain QEMU.
export function qemuPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (env.HOBWORK_QEMU_SANDBOX !== '1') return undefined
  if (platform !== 'linux') throw new Error('HOBWORK_QEMU_SANDBOX needs Linux')
  return SANDBOXED_QEMU
}
