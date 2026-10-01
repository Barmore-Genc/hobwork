import { join } from 'node:path'
import { isolationMode } from './isolation.ts'

const WATCHED_QEMU = join(import.meta.dirname, 'qemu-watched.sh')
const NAMESPACED_QEMU = join(import.meta.dirname, 'qemu-namespaced.sh')

// Only Linux QEMU is built with seccomp, so macOS dev runs plain QEMU. Both
// wrappers read HOBWORK_QEMU_SANDBOX themselves. bwrap's --die-with-parent
// already ends namespaced QEMU with the host.
export function qemuPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.HOBWORK_QEMU_SANDBOX === '1' && platform !== 'linux') throw new Error('HOBWORK_QEMU_SANDBOX needs Linux')
  return isolationMode(env, platform) === 'namespaces' ? NAMESPACED_QEMU : WATCHED_QEMU
}
