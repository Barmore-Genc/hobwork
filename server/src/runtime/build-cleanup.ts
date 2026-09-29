import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../git.ts'
import { repoPath, type Host } from '../host.ts'
import { getProject } from '../projects.ts'
import { listVersions } from '../versions.ts'
import { projectBuildsDir, treeOf } from './builds.ts'

// Older versions get built again when they are restored, so keeping a few is
// only about making the common restores fast.
export const KEEP_BUILD_VERSIONS = 10
// A pipeline stores the build of its candidate before the merge records the
// version, and a restore may be building one right now.
export const MIN_BUILD_AGE_MS = 60 * 60 * 1000

export type BuildCleanupOptions = {
  // Commits whose builds a VM runs or is about to run.
  inUse?: string[]
  keepVersions?: number
  minAgeMs?: number
  now?: number
}

// One git call for all commits, since this runs after every deploy.
async function treesOf(repo: string, commits: string[]): Promise<(string | undefined)[]> {
  if (!commits.length) return []
  try {
    return (await git(['--git-dir', repo, 'rev-parse', ...commits.map((c) => `${c}^{tree}`)])).trim().split('\n')
  } catch {
    return Promise.all(commits.map((commit) => treeOf(repo, commit).catch(() => undefined)))
  }
}

// Deletes the project's builds except those of its newest versions, those in
// use, and recent ones. Returns the trees it deleted.
export async function cleanupBuilds(host: Host, project: string, options: BuildCleanupOptions = {}): Promise<string[]> {
  const dir = projectBuildsDir(host, project)
  if (!existsSync(dir)) return []
  const now = options.now ?? Date.now()
  const minAgeMs = options.minAgeMs ?? MIN_BUILD_AGE_MS
  const repo = repoPath(host, project)
  const commits = [
    ...listVersions(host, project, options.keepVersions ?? KEEP_BUILD_VERSIONS).map((v) => v.commit),
    ...(options.inUse ?? []),
  ]
  const keep = new Set(await treesOf(repo, [...new Set(commits)]))
  const removed: string[] = []
  for (const entry of readdirSync(dir)) {
    // Staging directories of builds being saved.
    if (entry.startsWith('.') || keep.has(entry)) continue
    const path = join(dir, entry)
    let modified: number
    try {
      modified = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (now - modified < minAgeMs) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(entry)
  }
  return removed
}

// Builds of projects that no longer exist, e.g. left by a deletion that was
// interrupted.
export function removeOrphanBuilds(host: Host): string[] {
  const dir = join(host.dataDir, 'builds')
  if (!existsSync(dir)) return []
  const removed: string[] = []
  for (const project of readdirSync(dir)) {
    if (getProject(host, project)) continue
    rmSync(join(dir, project), { recursive: true, force: true })
    removed.push(project)
  }
  return removed
}
