import {
  createShadowPathPredicate,
  ReadonlyProvider,
  RealFSProvider,
  SandboxVfsProvider,
  ShadowProvider,
} from '@earendil-works/gondolin'
import type { VirtualProvider } from '@earendil-works/gondolin'
import { mountQuota } from './quota.ts'
import type { Mount } from './sandbox.ts'

// Shared by the in-process VFS and the VFS worker, so both serve a mount the same way.
export function toProviders(mounts: Record<string, Mount>): Record<string, VirtualProvider> {
  return Object.fromEntries(Object.entries(mounts).map(([guestPath, mount]) => [guestPath, toProvider(mount)]))
}

export function relativePaths(paths: string[] | undefined): string[] {
  return (paths ?? []).map((p) => p.replace(/^\/+|\/+$/g, ''))
}

function toProvider(mount: Mount): VirtualProvider {
  let provider: VirtualProvider = new RealFSProvider(mount.hostPath)
  if (mount.maxBytes !== undefined) provider = new SandboxVfsProvider(provider, mountQuota(mount.hostPath, mount.maxBytes))
  if (mount.readonly) provider = new ReadonlyProvider(provider)
  const hidden = [...relativePaths(mount.hide), ...relativePaths(mount.vmDisk)]
  if (hidden.length) {
    // Outside the readonly wrapper so the guest can still create the vmDisk mount points.
    provider = new ShadowProvider(provider, {
      shouldShadow: createShadowPathPredicate(hidden.map((p) => `/${p}`)),
      writeMode: 'tmpfs',
    })
  }
  return provider
}
