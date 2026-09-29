import { publishChange } from './changes.ts'
import { git, GitError } from './git.ts'
import { repoPath, type Host } from './host.ts'
import { DEFAULT_BRANCH, ProjectError, requireProject } from './projects.ts'

export type Branch = {
  name: string
  sha: string
  updatedAt: string
  subject: string
}

export type Commit = {
  sha: string
  author: string
  date: string
  subject: string
}

const BRANCH_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*'
const BRANCH_NAME = new RegExp(`^${BRANCH_SEGMENT}(/${BRANCH_SEGMENT})*$`)
const MAX_BRANCH_LENGTH = 100

export function validateBranchName(name: string): void {
  if (
    !BRANCH_NAME.test(name) ||
    name.length > MAX_BRANCH_LENGTH ||
    name.includes('..') ||
    /(\.lock|\.)(\/|$)/.test(name)
  ) {
    throw new ProjectError(
      `Invalid branch name "${name}": use letters, digits, ".", "_", "-" and "/" separated segments`,
    )
  }
}

export function assertNotDefaultBranch(branch: string): void {
  if (branch === DEFAULT_BRANCH) {
    throw new ProjectError(`${DEFAULT_BRANCH} is updated only by merging a branch`)
  }
}

function repoFor(host: Host, project: string): string {
  requireProject(host, project)
  return repoPath(host, project)
}

async function resolveRef(repo: string, ref: string): Promise<string | undefined> {
  // Refs come from agents; a leading dash would be parsed as a git option.
  if (ref.startsWith('-')) return undefined
  try {
    return (await git(['--git-dir', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
  } catch (err) {
    if (err instanceof GitError) return undefined
    throw err
  }
}

export async function branchExists(host: Host, project: string, branch: string): Promise<boolean> {
  validateBranchName(branch)
  return (await resolveRef(repoFor(host, project), `refs/heads/${branch}`)) !== undefined
}

// The commit a branch points at, if the branch exists.
export async function branchHead(host: Host, project: string, branch: string): Promise<string | undefined> {
  validateBranchName(branch)
  return resolveRef(repoFor(host, project), `refs/heads/${branch}`)
}

export async function listBranches(host: Host, project: string): Promise<Branch[]> {
  const out = await git([
    '--git-dir',
    repoFor(host, project),
    'for-each-ref',
    '--sort=refname',
    '--format=%(refname:lstrip=2)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)',
    'refs/heads/',
  ])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = '', updatedAt = '', subject = ''] = line.split('\0')
      return { name, sha, updatedAt, subject }
    })
}

export async function createBranch(
  host: Host,
  project: string,
  branch: string,
  from: string = DEFAULT_BRANCH,
): Promise<Branch> {
  validateBranchName(branch)
  assertNotDefaultBranch(branch)
  const repo = repoFor(host, project)
  const start = await resolveRef(repo, from)
  if (!start) throw new ProjectError(`Unknown ref "${from}" in ${project}`)
  if (await resolveRef(repo, `refs/heads/${branch}`)) {
    throw new ProjectError(`Branch "${branch}" already exists in ${project}`)
  }
  await git(['--git-dir', repo, 'update-ref', `refs/heads/${branch}`, start, ''])
  publishChange(host.db, { kind: 'branches', project })
  const created = (await listBranches(host, project)).find((b) => b.name === branch)
  if (!created) throw new Error(`Branch ${branch} missing after creation`)
  return created
}

// Callers that own a workspace for the branch must remove it first (see workspaces.ts).
export async function deleteBranchRef(host: Host, project: string, branch: string): Promise<void> {
  validateBranchName(branch)
  assertNotDefaultBranch(branch)
  const repo = repoFor(host, project)
  if (!(await resolveRef(repo, `refs/heads/${branch}`))) {
    throw new ProjectError(`Branch "${branch}" does not exist in ${project}`)
  }
  await git(['--git-dir', repo, 'update-ref', '-d', `refs/heads/${branch}`])
  publishChange(host.db, { kind: 'branches', project })
}

export async function log(
  host: Host,
  project: string,
  ref: string = DEFAULT_BRANCH,
  limit = 20,
): Promise<Commit[]> {
  const repo = repoFor(host, project)
  const sha = await resolveRef(repo, ref)
  if (!sha) throw new ProjectError(`Unknown ref "${ref}" in ${project}`)
  const out = await git([
    '--git-dir',
    repo,
    'log',
    `--max-count=${limit}`,
    '--format=%H%x00%an%x00%aI%x00%s',
    sha,
  ])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commitSha = '', author = '', date = '', subject = ''] = line.split('\0')
      return { sha: commitSha, author, date, subject }
    })
}

// Three-dot diff: what the branch changed since it diverged from base, which is
// what a merge would apply.
export async function diffBranch(
  host: Host,
  project: string,
  branch: string,
  base: string = DEFAULT_BRANCH,
): Promise<string> {
  const repo = repoFor(host, project)
  const [baseSha, branchSha] = await Promise.all([base, branch].map((ref) => resolveRef(repo, ref)))
  if (!baseSha) throw new ProjectError(`Unknown ref "${base}" in ${project}`)
  if (!branchSha) throw new ProjectError(`Unknown ref "${branch}" in ${project}`)
  return git(['--git-dir', repo, 'diff', `${baseSha}...${branchSha}`])
}

// Empty when the ref does not exist.
export async function listFilesAtRef(host: Host, project: string, ref: string): Promise<string[]> {
  const repo = repoFor(host, project)
  const sha = await resolveRef(repo, ref)
  if (!sha) return []
  return (await git(['--git-dir', repo, 'ls-tree', '-r', '--name-only', sha])).split('\n').filter(Boolean)
}

// Returns undefined when the file does not exist at that ref.
export async function readFileAtRef(
  host: Host,
  project: string,
  ref: string,
  path: string,
): Promise<string | undefined> {
  const repo = repoFor(host, project)
  const sha = await resolveRef(repo, ref)
  if (!sha) throw new ProjectError(`Unknown ref "${ref}" in ${project}`)
  try {
    return await git(['--git-dir', repo, 'show', `${sha}:${path}`])
  } catch (err) {
    if (err instanceof GitError) return undefined
    throw err
  }
}
