import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from './agents.ts'
import { publishChange } from './changes.ts'
import { git, GitError, HOBWORK_IDENTITY, type GitOptions } from './git.ts'
import { repoPath, workspaceDir, type Host } from './host.ts'
import { ProjectError, requireProject } from './projects.ts'
import { assertNotDefaultBranch, branchExists, deleteBranchRef, validateBranchName } from './repo.ts'

export type WorkspaceStatus = 'stopped' | 'starting' | 'running' | 'stopping'

export type Workspace = {
  id: number
  project: string
  branch: string
  status: WorkspaceStatus
  // Directory with the branch's files. This is what a workspace VM mounts.
  dir: string
  createdAt: string
  lastUsedAt: string
}

export type WorkspaceVm = {
  stop(): Promise<void>
  // True while a command runs. Busy VMs are never stopped for being idle.
  busy?(): boolean
  // True when the VM no longer matches the workspace (e.g. its egress
  // allowlist changed). The next start replaces it unless it is busy.
  isStale?(): boolean
}

export type ExecOptions = {
  // Relative to the workspace files directory ('.' for its root). The backend maps
  // it to wherever it mounts that directory in the guest.
  cwd: string
  timeoutMs: number
  // Aborted when the caller gives up (timeout or cancelled request). The backend
  // should kill the command.
  signal?: AbortSignal
  env?: Record<string, string>
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

export type ExecResult = {
  exitCode: number
  stdout: string
  stderr: string
}

// What agent tools need from a workspace VM. `command` is a shell command line.
export type ExecWorkspaceVm = WorkspaceVm & {
  exec(command: string, options: ExecOptions): Promise<ExecResult>
}

export type SpawnOptions = {
  // Relative to the workspace files directory, like ExecOptions.cwd.
  cwd: string
  env?: Record<string, string>
  // Allocates a pseudo-terminal of this size. Output then arrives on stdout only.
  pty?: { rows: number; cols: number }
  onData: (stream: 'stdout' | 'stderr', data: Buffer) => void
}

export type WorkspaceProcess = {
  result: Promise<{ exitCode: number }>
  write(data: string | Uint8Array): void
  // Closes stdin.
  end(): void
  resize(rows: number, cols: number): void
  kill(): Promise<void>
}

// Workspace VMs that also run interactive processes (SSH sessions).
export type InteractiveWorkspaceVm = ExecWorkspaceVm & {
  spawn(command: string, options: SpawnOptions): WorkspaceProcess
}

// Seam for the sandbox layer: start a VM with the workspace directory mounted
// read-write. The returned handle is kept while the workspace runs.
export type StartWorkspaceVm<Vm extends WorkspaceVm> = (workspace: Workspace) => Promise<Vm>

export type CommitAuthor = { name: string; email: string }

// Env var with the session token of the agent a command runs for. The `hobwork`
// CLI in the VM sends it back, so its calls act as that agent.
export const SESSION_ENV = 'HOBWORK_SESSION'

export type WorkspaceSession = {
  env: Record<string, string>
  close(): void
}

export type WorkspaceManager<Vm extends WorkspaceVm> = ReturnType<typeof createWorkspaceManager<Vm>>

// The git directory lives next to the files, not inside them. The VM only sees the
// files, so nothing it writes (config, hooks, filters) is ever run by host git.
function paths(host: Host, project: string, branch: string) {
  const root = workspaceDir(host, project, branch)
  return { root, files: join(root, 'files'), gitDir: join(root, 'git') }
}

function toWorkspace(host: Host, row: Record<string, unknown>): Workspace {
  const project = String(row.project)
  const branch = String(row.branch)
  return {
    id: Number(row.id),
    project,
    branch,
    status: String(row.status) as WorkspaceStatus,
    dir: paths(host, project, branch).files,
    createdAt: String(row.created_at),
    lastUsedAt: String(row.last_used_at),
  }
}

const SELECT = `SELECT w.id, p.name AS project, w.branch, w.status, w.created_at, w.last_used_at
  FROM workspaces w JOIN projects p ON p.id = w.project_id`

export type WorkspaceManagerOptions<Vm extends WorkspaceVm> = {
  startVm?: StartWorkspaceVm<Vm>
  // VMs not used for this long are stopped. Unset means never.
  idleTimeoutMs?: number
}

export function createWorkspaceManager<Vm extends WorkspaceVm>(
  host: Host,
  options: WorkspaceManagerOptions<Vm> = {},
) {
  const vms = new Map<number, Vm>()
  const queues = new Map<string, Promise<unknown>>()
  const sessions = new Map<string, { project: string; branch: string; agent: Agent }>()
  let idleTimer: NodeJS.Timeout | undefined

  // Checkout, git and VM operations on one workspace run one at a time, so two
  // tool calls cannot clone, commit or start the same workspace concurrently.
  function serialized<T>(project: string, branch: string, fn: () => Promise<T>): Promise<T> {
    const key = `${project}\0${branch}`
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    queues.set(key, run)
    void run
      .catch(() => {})
      .finally(() => {
        if (queues.get(key) === run) queues.delete(key)
      })
    return run
  }

  function get(project: string, branch: string): Workspace | undefined {
    const row = host.db
      .prepare(`${SELECT} WHERE p.name = ? AND w.branch = ?`)
      .get(project, branch)
    return row ? toWorkspace(host, row) : undefined
  }

  function getById(id: number): Workspace | undefined {
    const row = host.db.prepare(`${SELECT} WHERE w.id = ?`).get(id)
    return row ? toWorkspace(host, row) : undefined
  }

  function requireWorkspace(project: string, branch: string): Workspace {
    const workspace = get(project, branch)
    if (!workspace) throw new ProjectError(`No workspace for ${project}/${branch}`)
    return workspace
  }

  function list(project?: string): Workspace[] {
    const rows = project
      ? host.db.prepare(`${SELECT} WHERE p.name = ? ORDER BY w.branch`).all(project)
      : host.db.prepare(`${SELECT} ORDER BY p.name, w.branch`).all()
    return rows.map((row) => toWorkspace(host, row))
  }

  function setStatus(id: number, status: WorkspaceStatus): void {
    host.db.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, id)
  }

  function touch(project: string, branch: string): void {
    host.db
      .prepare(
        `UPDATE workspaces SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE branch = ? AND project_id = (SELECT id FROM projects WHERE name = ?)`,
      )
      .run(branch, project)
  }

  function workspaceGit(project: string, branch: string, args: string[], gitOptions: GitOptions = {}) {
    const { files, gitDir } = paths(host, project, branch)
    return git(['--git-dir', gitDir, '--work-tree', files, ...args], { ...gitOptions, cwd: files })
  }

  async function openUnlocked(project: string, branch: string): Promise<Workspace> {
    const { id: projectId } = requireProject(host, project)
    if (!(await branchExists(host, project, branch))) {
      throw new ProjectError(`Branch "${branch}" does not exist in ${project}`)
    }
    const { root, files, gitDir } = paths(host, project, branch)
    if (!existsSync(gitDir)) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      await git([
        'clone',
        '--quiet',
        '--branch',
        branch,
        '--separate-git-dir',
        gitDir,
        repoPath(host, project),
        files,
      ])
      rmSync(join(files, '.git'))
    }
    host.db
      .prepare(
        `INSERT INTO workspaces (project_id, branch) VALUES (?, ?)
         ON CONFLICT (project_id, branch)
         DO UPDATE SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(projectId, branch)
    return requireWorkspace(project, branch)
  }

  // Creates the checkout and record if needed. Safe to call on every access.
  function open(project: string, branch: string): Promise<Workspace> {
    validateBranchName(branch)
    return serialized(project, branch, () => openUnlocked(project, branch))
  }

  function start(project: string, branch: string): Promise<Vm> {
    const { startVm } = options
    if (!startVm) return Promise.reject(new Error('Workspace VMs are not available'))
    validateBranchName(branch)
    return serialized(project, branch, async () => {
      const workspace = await openUnlocked(project, branch)
      const existing = vms.get(workspace.id)
      if (existing) {
        if (existing.busy?.() || !existing.isStale?.()) return existing
        await stopUnlocked(project, branch)
      }
      setStatus(workspace.id, 'starting')
      try {
        const vm = await startVm({ ...workspace, status: 'starting' })
        vms.set(workspace.id, vm)
        setStatus(workspace.id, 'running')
        scheduleIdleCheck()
        return vm
      } catch (err) {
        setStatus(workspace.id, 'stopped')
        throw err
      }
    })
  }

  function isIdle(workspace: Workspace, now: number): boolean {
    const { idleTimeoutMs } = options
    const vm = vms.get(workspace.id)
    if (idleTimeoutMs === undefined || !vm || vm.busy?.()) return false
    return now - Date.parse(workspace.lastUsedAt) >= idleTimeoutMs
  }

  // Stops VMs that have not been used for the idle timeout.
  async function stopIdle(now = Date.now()): Promise<void> {
    const idle = [...vms.keys()]
      .map(getById)
      .filter((w): w is Workspace => w !== undefined && isIdle(w, now))
    await Promise.all(
      idle.map(({ project, branch }) =>
        serialized(project, branch, async () => {
          // A command may have started while this was queued.
          const current = get(project, branch)
          if (current && isIdle(current, now)) await stopUnlocked(project, branch)
        }).catch((err: unknown) => console.error(`Stopping idle workspace ${project}/${branch} failed`, err)),
      ),
    )
  }

  function scheduleIdleCheck(): void {
    const { idleTimeoutMs } = options
    if (idleTimeoutMs === undefined || idleTimer) return
    idleTimer = setInterval(
      () => {
        void stopIdle().then(() => {
          if (vms.size === 0 && idleTimer) {
            clearInterval(idleTimer)
            idleTimer = undefined
          }
        })
      },
      Math.min(Math.max(idleTimeoutMs / 4, 100), 60_000),
    )
    idleTimer.unref()
  }

  async function stopAll(): Promise<void> {
    clearInterval(idleTimer)
    idleTimer = undefined
    const running = [...vms.keys()]
      .map(getById)
      .filter((w): w is Workspace => w !== undefined)
    await Promise.all(
      running.map(({ project, branch }) =>
        stop(project, branch).catch((err: unknown) =>
          console.error(`Stopping workspace ${project}/${branch} failed`, err),
        ),
      ),
    )
  }

  async function stopUnlocked(project: string, branch: string): Promise<void> {
    const workspace = get(project, branch)
    if (!workspace) return
    const vm = vms.get(workspace.id)
    if (!vm) return setStatus(workspace.id, 'stopped')
    setStatus(workspace.id, 'stopping')
    try {
      await vm.stop()
    } finally {
      vms.delete(workspace.id)
      setStatus(workspace.id, 'stopped')
    }
  }

  // Brings the checkout to the branch tip in the project repo, discarding local
  // changes. Only for checkouts nothing else writes to, such as main's.
  function sync(project: string, branch: string): Promise<Workspace> {
    validateBranchName(branch)
    return serialized(project, branch, async () => {
      const workspace = await openUnlocked(project, branch)
      const remote = `refs/remotes/origin/${branch}`
      await workspaceGit(project, branch, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${remote}`])
      await workspaceGit(project, branch, ['reset', '--quiet', '--hard', remote])
      await workspaceGit(project, branch, ['clean', '--quiet', '-fdx'])
      return workspace
    })
  }

  function stop(project: string, branch: string): Promise<void> {
    return serialized(project, branch, () => stopUnlocked(project, branch))
  }

  async function removeUnlocked(project: string, branch: string): Promise<void> {
    await stopUnlocked(project, branch)
    const workspace = get(project, branch)
    rmSync(paths(host, project, branch).root, { recursive: true, force: true })
    if (workspace) host.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id)
  }

  function remove(project: string, branch: string): Promise<void> {
    validateBranchName(branch)
    return serialized(project, branch, () => removeUnlocked(project, branch))
  }

  function deleteBranch(project: string, branch: string): Promise<void> {
    validateBranchName(branch)
    return serialized(project, branch, async () => {
      assertNotDefaultBranch(branch)
      await removeUnlocked(project, branch)
      await deleteBranchRef(host, project, branch)
    })
  }

  // Stages everything, commits and pushes to the branch in the project repo.
  // Returns the new commit, or undefined when there was nothing to commit.
  function commit(
    project: string,
    branch: string,
    message: string,
    author: CommitAuthor = { name: 'Hobwork', email: HOBWORK_IDENTITY.GIT_AUTHOR_EMAIL },
  ): Promise<string | undefined> {
    return serialized(project, branch, async () => {
      if (!message.trim()) throw new ProjectError('Commit message must not be empty')
      requireWorkspace(project, branch)
      touch(project, branch)
      await workspaceGit(project, branch, ['add', '--all'])
      const status = await workspaceGit(project, branch, ['status', '--porcelain'])
      if (!status.trim()) return undefined
      await workspaceGit(project, branch, ['commit', '--quiet', '--file', '-'], {
        input: message,
        env: { ...HOBWORK_IDENTITY, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email },
      })
      await workspaceGit(project, branch, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`])
      publishChange(host.db, { kind: 'branches', project })
      return (await workspaceGit(project, branch, ['rev-parse', 'HEAD'])).trim()
    })
  }

  // Moves the branch from `from` to `to` and resets its workspace checkout to
  // match, keeping ignored files such as node_modules. Returns false and changes
  // nothing if the branch or the workspace changed since `from`.
  function moveBranch(project: string, branch: string, from: string, to: string): Promise<boolean> {
    validateBranchName(branch)
    return serialized(project, branch, async () => {
      assertNotDefaultBranch(branch)
      const workspace = get(project, branch)
      if (workspace) {
        const head = (await workspaceGit(project, branch, ['rev-parse', 'HEAD'])).trim()
        const status = await workspaceGit(project, branch, ['status', '--porcelain'])
        if (head !== from || status.trim()) return false
      }
      try {
        await git(['--git-dir', repoPath(host, project), 'update-ref', `refs/heads/${branch}`, to, from])
      } catch (err) {
        if (err instanceof GitError) return false
        throw err
      }
      publishChange(host.db, { kind: 'branches', project })
      if (workspace) {
        const remote = `refs/remotes/origin/${branch}`
        await workspaceGit(project, branch, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${remote}`])
        await workspaceGit(project, branch, ['reset', '--quiet', '--hard', remote])
      }
      return true
    })
  }

  // Points the checkout at the project repo again after the project moved
  // (a rename), since the clone remembers the repo's path.
  function relink(project: string, branch: string): Promise<void> {
    return serialized(project, branch, async () => {
      if (!existsSync(paths(host, project, branch).gitDir)) return
      await workspaceGit(project, branch, ['remote', 'set-url', 'origin', repoPath(host, project)])
    })
  }

  // Uncommitted changes in the workspace, including new files.
  function diff(project: string, branch: string): Promise<string> {
    return serialized(project, branch, async () => {
      requireWorkspace(project, branch)
      touch(project, branch)
      await workspaceGit(project, branch, ['add', '--all'])
      return workspaceGit(project, branch, ['diff', '--cached', 'HEAD'])
    })
  }

  // Uncommitted changes as `git status --porcelain` lines.
  function changes(project: string, branch: string): Promise<string[]> {
    return serialized(project, branch, async () => {
      requireWorkspace(project, branch)
      const status = await workspaceGit(project, branch, ['status', '--porcelain', '--untracked-files=all'])
      return status.split('\n').filter(Boolean)
    })
  }

  // Open while a command runs for `agent` in the workspace VM.
  function openSession(project: string, branch: string, agent: Agent): WorkspaceSession {
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, { project, branch, agent })
    return { env: { [SESSION_ENV]: token }, close: () => void sessions.delete(token) }
  }

  function sessionAgent(project: string, branch: string, token: string): Agent | undefined {
    const session = sessions.get(token)
    return session && session.project === project && session.branch === branch ? session.agent : undefined
  }

  // VM handles do not survive a host restart.
  function resetStatuses(): void {
    host.db.prepare("UPDATE workspaces SET status = 'stopped' WHERE status != 'stopped'").run()
  }

  return {
    canStartVms: options.startVm !== undefined,
    get,
    list,
    open,
    sync,
    start,
    stop,
    stopIdle,
    stopAll,
    remove,
    deleteBranch,
    touch,
    commit,
    diff,
    changes,
    moveBranch,
    relink,
    openSession,
    sessionAgent,
    resetStatuses,
  }
}
