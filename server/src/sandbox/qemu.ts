import { join } from 'node:path'
import { isolationMode } from './isolation.ts'

const SANDBOXED_QEMU = join(import.meta.dirname, 'qemu-sandboxed.sh')
const NAMESPACED_QEMU = join(import.meta.dirname, 'qemu-namespaced.sh')

// Only Linux QEMU is built with seccomp, so macOS dev runs plain QEMU. In
// namespaces, qemu-namespaced.sh reads HOBWORK_QEMU_SANDBOX itself.
export function qemuPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const seccomp = env.HOBWORK_QEMU_SANDBOX === '1'
  if (seccomp && platform !== 'linux') throw new Error('HOBWORK_QEMU_SANDBOX needs Linux')
  if (isolationMode(env, platform) === 'namespaces') return NAMESPACED_QEMU
  return seccomp ? SANDBOXED_QEMU : undefined
}
