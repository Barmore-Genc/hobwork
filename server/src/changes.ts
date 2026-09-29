import type { DatabaseSync } from 'node:sqlite'

// What changed, so open web UI pages can load it again (see "Live updates" in
// docs/architecture.md). Changes name what changed, never its content.
export type Change =
  // Projects were created, deleted, renamed or restored.
  | { kind: 'projects' }
  // Versions, status, the deployed version or its entry points.
  | { kind: 'project'; project: string }
  | { kind: 'invocations'; project: string; id: number }
  | { kind: 'logs'; project: string }
  // Branches, their heads, previews and Home Assistant approvals.
  | { kind: 'branches'; project: string }
  // The library, assignments and host requests.
  | { kind: 'secrets' }
  // Agents, their keys, OAuth connections and SSH keys.
  | { kind: 'agents' }
  | { kind: 'devices' }
  | { kind: 'trash' }
  | { kind: 'backups' }

export type ChangeListener = (change: Change) => void

// Keyed by the host DB, so each host (tests run several) has its own
// listeners, and code that only has the DB can publish.
const listeners = new WeakMap<DatabaseSync, Set<ChangeListener>>()

export function publishChange(db: DatabaseSync, ...changes: Change[]): void {
  for (const change of changes) {
    for (const listener of listeners.get(db) ?? []) {
      try {
        listener(change)
      } catch (err) {
        console.error('A change listener failed', err)
      }
    }
  }
}

// Project names show up in the lists of these, so a project that comes, goes
// or gets another name changes them too.
export function projectListChanges(...projects: string[]): Change[] {
  return [
    { kind: 'projects' },
    ...projects.map((project) => ({ kind: 'project', project }) as const),
    { kind: 'agents' },
    { kind: 'secrets' },
  ]
}

export function onChange(db: DatabaseSync, listener: ChangeListener): () => void {
  let set = listeners.get(db)
  if (!set) listeners.set(db, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}
