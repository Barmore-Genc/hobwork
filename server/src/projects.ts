import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { git, HOBWORK_IDENTITY } from './git.ts'
import { repoPath, type Host } from './host.ts'

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
const MAX_NAME_LENGTH = 64

export function validateProjectName(name: string): void {
  if (!PROJECT_NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new ProjectError(
      `Invalid project name "${name}": use lowercase letters, digits and single hyphens (kebab-case), at most ${MAX_NAME_LENGTH} characters`,
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

export function requireProject(host: Host, name: string): Project {
  const project = getProject(host, name)
  if (!project) throw new ProjectError(`Project "${name}" does not exist`)
  return project
}

export async function createProject(host: Host, name: string): Promise<Project> {
  validateProjectName(name)
  if (getProject(host, name)) throw new ProjectError(`Project "${name}" already exists`)
  const repo = repoPath(host, name)
  if (existsSync(repo)) throw new ProjectError(`Repository for "${name}" already exists`)

  const staging = mkdtempSync(join(tmpdir(), 'hobwork-template-'))
  try {
    await git(['init', '--bare', '--initial-branch', DEFAULT_BRANCH, repo])
    installHooks(repo)
    await commitTemplate(repo, name, staging)
    const row = host.db
      .prepare(
        'INSERT INTO projects (name, default_branch) VALUES (?, ?) RETURNING id, name, default_branch, created_at',
      )
      .get(name, DEFAULT_BRANCH)
    if (!row) throw new Error('Project insert returned no row')
    return toProject(row)
  } catch (err) {
    rmSync(repo, { recursive: true, force: true })
    throw err
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function commitTemplate(repo: string, name: string, staging: string): Promise<void> {
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
    await git(['--git-dir', repo, 'commit-tree', treeId, '-m', 'Create project from template'], {
      env,
    })
  ).trim()
  await git(['--git-dir', repo, 'update-ref', `refs/heads/${DEFAULT_BRANCH}`, commit, ''])
}
