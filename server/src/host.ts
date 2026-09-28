import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export type Host = {
  db: DatabaseSync
  dataDir: string
}

export function reposDir(host: Host): string {
  return join(host.dataDir, 'repos')
}

export function repoPath(host: Host, project: string): string {
  return join(reposDir(host), `${project}.git`)
}

// Branch names may contain slashes; encoding keeps one directory per branch so
// removing a workspace never touches another branch's files.
export function workspaceDir(host: Host, project: string, branch: string): string {
  return join(host.dataDir, 'workspaces', project, encodeURIComponent(branch))
}
