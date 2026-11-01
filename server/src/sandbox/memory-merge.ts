import { readFileSync } from 'node:fs'

// The QEMU wrappers (qemu-watched.sh, qemu-namespaced.sh) mark guest RAM
// mergeable, and the host's KSM merges the identical pages between VMs: the
// kernel, the initramfs, and what every guest read from the same rootfs image.
// Only the host can turn the merging on, and the marking does nothing without it.
const KSM_RUN = '/sys/kernel/mm/ksm/run'

export function memoryMergeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HOBWORK_VM_MEMORY_MERGE !== '0'
}

// Undefined when merging is off or already on, or on a host where nothing can be
// done about it.
export function memoryMergeNotice(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => string | undefined = readSysfs,
): string | undefined {
  if (!memoryMergeEnabled(env) || platform !== 'linux') return undefined
  const run = read(KSM_RUN)
  if (run === undefined) {
    return 'This kernel has no KSM, so VMs keep their own copy of the guest image pages they read.'
  }
  if (run.trim() !== '1') {
    return [
      'KSM is off, so every VM keeps its own copy of the guest image pages it reads.',
      'Turn the sharing on with "echo 1 > /sys/kernel/mm/ksm/run" as root, after reading "Memory sharing between VMs" in docs/architecture.md: co-resident VMs can then tell which pages another one holds.',
    ].join(' ')
  }
  return undefined
}

function readSysfs(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
