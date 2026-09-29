import type { Host } from './host.ts'
import { purgeTrash } from './project-deletion.ts'
import { listProjects } from './projects.ts'
import { removeOrphanBuilds } from './runtime/build-cleanup.ts'
import type { Runtime } from './runtime/runtime.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// Daily cleanup: deleted projects past their time in the trash, and builds
// nothing needs any more.
export async function runHousekeeping(host: Host, runtime?: Pick<Runtime, 'removeOldBuilds'>, now = Date.now()) {
  for (const entry of purgeTrash(host, now)) console.log(`Removed ${entry} from the trash`)
  for (const project of removeOrphanBuilds(host)) console.log(`Removed the builds of ${project}, which no longer exists`)
  for (const { name } of listProjects(host)) await runtime?.removeOldBuilds(name)
}

export function startHousekeeping(host: Host, runtime?: Pick<Runtime, 'removeOldBuilds'>, intervalMs = DAY_MS) {
  const run = () =>
    void runHousekeeping(host, runtime).catch((err: unknown) => console.error('Housekeeping failed', err))
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
