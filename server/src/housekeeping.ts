import { pruneAiRequests } from './ai/usage.ts'
import { pruneShareLinks } from './apps/share-links.ts'
import { removeMergedBranches, type BranchDeletionDeps } from './branch-deletion.ts'
import type { Host } from './host.ts'
import { purgeTrash } from './project-deletion.ts'
import { listProjects } from './projects.ts'
import { removeOrphanBuilds } from './runtime/build-cleanup.ts'
import type { Runtime } from './runtime/runtime.ts'

const DAY_MS = 24 * 60 * 60 * 1000

type HousekeepingDeps = {
  runtime?: Pick<Runtime, 'removeOldBuilds'>
  branches?: Omit<BranchDeletionDeps, 'host'>
}

// Daily cleanup: deleted projects past their time in the trash, merged
// branches nobody uses, builds nothing needs any more, old AI request records
// and expired share links.
export async function runHousekeeping(host: Host, deps: HousekeepingDeps = {}, now = Date.now()) {
  const { runtime, branches } = deps
  for (const entry of purgeTrash(host, now)) console.log(`Removed ${entry} from the trash`)
  if (branches) {
    for (const branch of await removeMergedBranches({ host, ...branches }, now)) console.log(`Removed the merged branch ${branch}`)
  }
  for (const project of removeOrphanBuilds(host)) console.log(`Removed the builds of ${project}, which no longer exists`)
  for (const { name } of listProjects(host)) await runtime?.removeOldBuilds(name)
  pruneAiRequests(host.db, now)
  pruneShareLinks(host.db, now)
}

export function startHousekeeping(host: Host, deps: HousekeepingDeps = {}, intervalMs = DAY_MS) {
  const run = () =>
    void runHousekeeping(host, deps).catch((err: unknown) => console.error('Housekeeping failed', err))
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
