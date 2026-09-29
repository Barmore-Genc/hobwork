import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { publishChange } from './changes.ts'
import { git, HOBWORK_IDENTITY } from './git.ts'
import { repoPath, type Host } from './host.ts'
import { recordVersion } from './versions.ts'

export const templateDir = resolve(import.meta.dirname, '../../templates/project')

export const DEFAULT_BRANCH = 'main'

export type Project = {
  id: number
  name: string
  defaultBranch: string
  createdAt: string
}

export class ProjectError extends Error {}

const PROJECT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
// The name is a DNS label of the project's app origin, and branch previews
// put up to 21 more characters in front of it (63 at most).
const MAX_NAME_LENGTH = 40

export function validateProjectName(name: string): void {
  if (!PROJECT_NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new ProjectError(
      `Invalid hob name "${name}": use lowercase letters, digits and single hyphens (kebab-case), at most ${MAX_NAME_LENGTH} characters`,
    )
  }
}

// Never passed through from HTTP requests or workspaces, so only host code that
// sets it explicitly (merge, restore) can update main.
export const ALLOW_MAIN_ENV = { HOBWORK_ALLOW_MAIN: '1' }

const PRE_RECEIVE_HOOK = `#!/bin/sh
[ "$HOBWORK_ALLOW_MAIN" = 1 ] && exit 0
status=0
while read -r old new ref; do
  if [ "$ref" = "refs/heads/${DEFAULT_BRANCH}" ]; then
    echo "Pushing to ${DEFAULT_BRANCH} is not allowed. Push a branch and merge it with the merge tool." >&2
    status=1
  fi
done
exit $status
`

export function installHooks(repo: string): void {
  const hook = join(repo, 'hooks', 'pre-receive')
  writeFileSync(hook, PRE_RECEIVE_HOOK)
  chmodSync(hook, 0o755)
}

function toProject(row: Record<string, unknown>): Project {
  return {
    id: Number(row.id),
    name: String(row.name),
    defaultBranch: String(row.default_branch),
    createdAt: String(row.created_at),
  }
}

export function listProjects(host: Host): Project[] {
  return host.db
    .prepare('SELECT id, name, default_branch, created_at FROM projects ORDER BY name')
    .all()
    .map(toProject)
}

export function getProject(host: Host, name: string): Project | undefined {
  const row = host.db
    .prepare('SELECT id, name, default_branch, created_at FROM projects WHERE name = ?')
    .get(name)
  return row ? toProject(row) : undefined
}

// The project that was called `name` before it was renamed, while no project
// has that name.
export function renamedProject(host: Host, name: string): Project | undefined {
  const row = host.db
    .prepare(
      `SELECT p.id, p.name, p.default_branch, p.created_at FROM project_renames r
       JOIN projects p ON p.id = r.project_id WHERE r.name = ?`,
    )
    .get(name)
  return row ? toProject(row) : undefined
}

// The project by its name, or by a name it had before a rename.
export function getProjectOrRenamed(host: Host, name: string): Project | undefined {
  return getProject(host, name) ?? renamedProject(host, name)
}

export function requireProject(host: Host, name: string): Project {
  const project = getProject(host, name)
  if (!project) {
    const renamed = renamedProject(host, name)
    throw new ProjectError(
      renamed ? `Hob "${name}" was renamed to "${renamed.name}"` : `Hob "${name}" does not exist`,
    )
  }
  return project
}

// A project that takes a name ends its use as an old name of another project.
export function claimName(host: Host, name: string): void {
  host.db.prepare('DELETE FROM project_renames WHERE name = ?').run(name)
}

export async function createProject(host: Host, name: string): Promise<Project> {
  validateProjectName(name)
  if (getProject(host, name)) throw new ProjectError(`Hob "${name}" already exists`)
  const repo = repoPath(host, name)
  if (existsSync(repo)) throw new ProjectError(`Repository for "${name}" already exists`)

  const staging = mkdtempSync(join(tmpdir(), 'hobwork-template-'))
  try {
    await git(['init', '--bare', '--initial-branch', DEFAULT_BRANCH, repo])
    installHooks(repo)
    const commit = await commitTemplate(repo, name, staging)
    const row = host.db
      .prepare(
        'INSERT INTO projects (name, default_branch) VALUES (?, ?) RETURNING id, name, default_branch, created_at',
      )
      .get(name, DEFAULT_BRANCH)
    if (!row) throw new Error('Project insert returned no row')
    const project = toProject(row)
    claimName(host, name)
    // Version 1 is the template, so even the first merge can be restored away from.
    recordVersion(host, { projectId: project.id, commit, summary: TEMPLATE_COMMIT_MESSAGE })
    publishChange(host.db, { kind: 'projects' })
    return project
  } catch (err) {
    rmSync(repo, { recursive: true, force: true })
    throw err
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

const TEMPLATE_COMMIT_MESSAGE = 'Create hob from template'

async function commitTemplate(repo: string, name: string, staging: string): Promise<string> {
  const tree = join(staging, 'tree')
  cpSync(templateDir, tree, { recursive: true })
  const packageJson = join(tree, 'package.json')
  const pkg = JSON.parse(readFileSync(packageJson, 'utf8'))
  writeFileSync(packageJson, `${JSON.stringify({ ...pkg, name }, null, 2)}\n`)

  const env = { ...HOBWORK_IDENTITY, GIT_INDEX_FILE: join(staging, 'index') }
  const base = ['--git-dir', repo, '--work-tree', tree]
  await git([...base, 'add', '--all'], { env })
  const treeId = (await git([...base, 'write-tree'], { env })).trim()
  const commit = (
    await git(['--git-dir', repo, 'commit-tree', treeId, '-m', TEMPLATE_COMMIT_MESSAGE], {
      env,
    })
  ).trim()
  await git(['--git-dir', repo, 'update-ref', `refs/heads/${DEFAULT_BRANCH}`, commit, ''])
  return commit
}
