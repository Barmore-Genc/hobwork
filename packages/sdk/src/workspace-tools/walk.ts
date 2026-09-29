export const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

export type DirEntry<Loc> = {
  name: string
  // 'other' is anything that is neither a directory nor a regular file, such as a symlink.
  kind: 'dir' | 'file' | 'other'
  loc: Loc
  size?: number
}

export type WalkOptions<Loc> = {
  readDir: (loc: Loc) => Promise<DirEntry<Loc>[]>
  recursive: boolean
  // Called for files, and for directories and other entries in a non-recursive
  // walk. Returns false to stop the walk.
  visit: (entry: DirEntry<Loc>, rel: string) => Promise<boolean> | boolean
}

// Shared by the in-VM file tools and the host's reads from git, so both list
// and search files in the same order.
export async function walk<Loc>(start: Loc, prefix: string, options: WalkOptions<Loc>): Promise<boolean> {
  const children = (await options.readDir(start)).sort((a, b) => a.name.localeCompare(b.name))
  for (const child of children) {
    const rel = prefix ? `${prefix}/${child.name}` : child.name
    if (child.kind === 'dir' && options.recursive) {
      if (SKIPPED_DIRS.has(child.name)) continue
      if (!(await walk(child.loc, rel, options))) return false
    } else if (!(await options.visit(child, rel))) {
      return false
    }
  }
  return true
}
