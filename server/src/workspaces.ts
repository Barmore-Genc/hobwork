import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from './agents.ts'
import { publishChange } from './changes.ts'
import { git, GitError } from './git.ts'
import { repoPath, workspaceDir, type Host } from './host.ts'
import { ProjectError, requireProject } from './projects.ts'
import { assertNotDefaultBranch, branchExists, branchHead, deleteBranchRef, validateBranchName } from './repo.ts'
import { INTERNAL_HOST } from './sandbox/sandbox.ts'
import { runFileTool, runGitTool, type ToolOptions } from './workspace-tools.ts'
import type { FileRequest, FileResponse } from '../../packages/sdk/src/workspace-tools/files.ts'

export type WorkspaceStatus = 'stopped' | 'starting' | 'running' | 'stopping'

export type Workspace = {
  id: number
  project: string
  branch: string
  status: WorkspaceStatus
  // Directory with the branch's files. A workspace VM mounts it read-write.
  dir: string
  // The checkout's git directory. A workspace VM mounts it too. The host never
  // runs git in it after creating it, since the VM can write to it.
  gitDir: string
  createdAt: string
  lastUsedAt: string
}

export type WorkspaceVm = {
  stop(): Promise<void>
  // True while a command runs. Busy VMs are never stopped for being idle.
  busy?(): boolean
  // True when the VM no longer matches the workspace (e.g. its egress
  // allowlist changed). The next start replaces it unless it is busy.
  isStale?(): boolean | Promise<boolean>
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
  // Written to the command's stdin, which is then closed.
  input?: string
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

export type ExecResult = {
  exitCode: number
  stdout: string
  stderr: string
}

// What agent tools need from a workspace VM. `command` is a shell command line.
// File and git tools run through it (see workspace-tools.ts).
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

// Env var with the session token of the agent a command runs for. The `hobwork`
// CLI in the VM sends it back, so its calls act as that agent.
export const SESSION_ENV = 'HOBWORK_SESSION'
// The host's own tool calls (file tools, git) run as the same unprivileged user
// as agent commands, so their token is readable by them. It only works for
// pushing to the workspace's branch.
export const TOOL_SESSION_ENV = 'HOBWORK_TOOL_SESSION'
export const SESSION_HEADER = 'x-hobwork-session'

const NO_VMS =
  'Workspace VMs are not available on this Hobwork host, so uncommitted changes cannot be read or changed. Committed files can still be read'

// Identity of tools the host runs itself in the VM, such as resetting a checkout.
const HOBWORK_AGENT: Agent = { id: 0, name: 'Hobwork' }

export type WorkspaceSession = {
  env: Record<string, string>
  close(): void
}

export type WorkspaceManager<Vm extends ExecWorkspaceVm> = ReturnType<typeof createWorkspaceManager<Vm>>

// The git directory lives next to the files, not inside them, so the checkout
// has no .git entry that could point git somewhere else.
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
    gitDir: paths(host, project, branch).gitDir,
    createdAt: String(row.created_at),
    lastUsedAt: String(row.last_used_at),
  }
}

const SELECT = `SELECT w.id, p.name AS project, w.branch, w.status, w.created_at, w.last_used_at
  FROM workspaces w JOIN projects p ON p.id = w.project_id`

const RECLAIM_MIN_IDLE_MS = 30_000

export type WorkspaceManagerOptions<Vm extends ExecWorkspaceVm> = {
  startVm?: StartWorkspaceVm<Vm>
  // VMs not used for this long are stopped. Unset means never.
  idleTimeoutMs?: number
}

export function createWorkspaceManager<Vm extends ExecWorkspaceVm>(
  host: Host,
  options: WorkspaceManagerOptions<Vm> = {},
) {
  const vms = new Map<number, Vm>()
  const queues = new Map<string, Promise<unknown>>()
  const sessions = new Map<string, { project: string; branch: string; agent: Agent; command: boolean }>()
  // Whether the checkout may have uncommitted changes. Missing means unknown
  // (after a host restart), which counts as dirty until a status check says otherwise.
  const dirty = new Map<string, boolean>()
  let idleTimer: NodeJS.Timeout | undefined

  function key(project: string, branch: string): string {
    return `${project}\0${branch}`
  }

  // Checkout, git and VM operations on one workspace run one at a time, so two
  // tool calls cannot clone, commit or start the same workspace concurrently.
  function serialized<T>(project: string, branch: string, fn: () => Promise<T>): Promise<T> {
    const queue = key(project, branch)
    const run = (queues.get(queue) ?? Promise.resolve()).catch(() => {}).then(fn)
    queues.set(queue, run)
    void run
      .catch(() => {})
      .finally(() => {
        if (queues.get(queue) === run) queues.delete(queue)
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

  async function openUnlocked(project: string, branch: string): Promise<Workspace> {
    const { id: projectId } = requireProject(host, project)
    if (!(await branchExists(host, project, branch))) {
      throw new ProjectError(`Branch "${branch}" does not exist in ${project}`)
    }
    const { root, files, gitDir } = paths(host, project, branch)
    if (!existsSync(gitDir)) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      // No hardlinks: the VM can write to the checkout's objects, and a hardlink
      // would let it reach the ones in the project repo.
      await git([
        'clone',
        '--quiet',
        '--no-hardlinks',
        '--branch',
        branch,
        '--separate-git-dir',
        gitDir,
        repoPath(host, project),
        files,
      ])
      rmSync(join(files, '.git'))
      // The VM pushes and fetches through hobwork.internal, so the host path stays out of its sight.
      await git(['--git-dir', gitDir, 'remote', 'remove', 'origin'])
      await git(['--git-dir', gitDir, 'config', '--unset', 'core.worktree']).catch(() => {})
      dirty.set(key(project, branch), false)
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

  async function startUnlocked(project: string, branch: string): Promise<Vm> {
    const { startVm } = options
    if (!startVm) throw new ProjectError(NO_VMS)
    const workspace = await openUnlocked(project, branch)
    const existing = vms.get(workspace.id)
    if (existing) {
      if (existing.busy?.() || !(await existing.isStale?.())) return existing
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
  }

  function start(project: string, branch: string): Promise<Vm> {
    if (!options.startVm) return Promise.reject(new ProjectError(NO_VMS))
    validateBranchName(branch)
    return serialized(project, branch, () => startUnlocked(project, branch))
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

  // Stops the VM when the VM budget needs the room, unless a command runs in it
  // or it was used a moment ago (a VM that has just started is not idle).
  function stopIfIdle(project: string, branch: string): Promise<boolean> {
    return serialized(project, branch, async () => {
      const workspace = get(project, branch)
      const vm = workspace && vms.get(workspace.id)
      if (!workspace || !vm || vm.busy?.()) return false
      if (Date.now() - Date.parse(workspace.lastUsedAt) < RECLAIM_MIN_IDLE_MS) return false
      await stopUnlocked(project, branch)
      return true
    })
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

  function stop(project: string, branch: string): Promise<void> {
    return serialized(project, branch, () => stopUnlocked(project, branch))
  }

  async function removeUnlocked(project: string, branch: string): Promise<void> {
    await stopUnlocked(project, branch)
    const workspace = get(project, branch)
    rmSync(paths(host, project, branch).root, { recursive: true, force: true })
    if (workspace) host.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id)
    dirty.delete(key(project, branch))
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

  const remoteUrl = (project: string) => `http://${INTERNAL_HOST}/git/${project}.git`

  function hasSession(project: string, branch: string): boolean {
    for (const session of sessions.values()) {
      if (session.command && session.project === project && session.branch === branch) return true
    }
    return false
  }

  // A checkout counts as clean only while no command or shell can be changing it.
  function noteChanges(project: string, branch: string, clean: boolean): void {
    dirty.set(key(project, branch), !clean || hasSession(project, branch))
  }

  function markDirty(project: string, branch: string): void {
    dirty.set(key(project, branch), true)
  }

  // Runs `fn` with the workspace VM, starting it if needed. The tools the VM
  // runs push and fetch through hobwork.internal, so they get a session of their own.
  function withVm<T>(
    project: string,
    branch: string,
    agent: Agent | undefined,
    fn: (vm: Vm, tool: ToolOptions) => Promise<T>,
  ): Promise<T> {
    validateBranchName(branch)
    return serialized(project, branch, async () => {
      const vm = await startUnlocked(project, branch)
      touch(project, branch)
      const session = newSession(project, branch, agent ?? HOBWORK_AGENT)
      try {
        return await fn(vm, { env: session.env })
      } finally {
        session.close()
      }
    })
  }

  // Whether reads may come from the project repo instead of the checkout: there
  // is no workspace, or it has nothing uncommitted. Asks the VM when unsure.
  async function isCommitted(project: string, branch: string): Promise<boolean> {
    validateBranchName(branch)
    if (!get(project, branch)) return true
    const known = dirty.get(key(project, branch))
    if (known !== undefined) return !known
    return (await changes(project, branch)).length === 0
  }

  // Runs a file tool in the workspace VM. Tools that change files mark the
  // checkout as having uncommitted changes.
  function files(
    project: string,
    branch: string,
    request: FileRequest,
    options: Pick<ToolOptions, 'signal' | 'timeoutMs'> = {},
  ): Promise<FileResponse> {
    return withVm(project, branch, undefined, async (vm, tool) => {
      if (request.op === 'write' || request.op === 'edit' || request.op === 'delete') markDirty(project, branch)
      return runFileTool(vm, request, { ...tool, ...options })
    })
  }

  // Stages everything, commits and pushes to the branch in the project repo,
  // from inside the VM. Returns the new commit, or undefined when there was
  // nothing to commit.
  function commit(project: string, branch: string, message: string, agent: Agent): Promise<string | undefined> {
    if (!message.trim()) return Promise.reject(new ProjectError('Commit message must not be empty'))
    if (!get(project, branch)) return Promise.resolve(undefined)
    return withVm(project, branch, agent, async (vm, tool) => {
      const result = await runGitTool(
        vm,
        {
          op: 'commit',
          message,
          authorName: agent.name,
          authorEmail: `agent-${agent.id}@hobwork.local`,
          remote: remoteUrl(project),
          branch,
        },
        tool,
      )
      if (!result.committed) return undefined
      // The VM says what it pushed. The repo says what the branch is.
      if ((await branchHead(host, project, branch)) !== result.sha) {
        throw new ProjectError(`The push to ${branch} did not arrive`)
      }
      noteChanges(project, branch, result.clean)
      publishChange(host.db, { kind: 'branches', project })
      return result.sha
    })
  }

  // Moves the branch from `from` to `to` and resets its workspace checkout to
  // match, keeping ignored files. Returns false and changes nothing if the
  // branch or the workspace changed since `from`, or the checkout cannot be reset.
  function moveBranch(project: string, branch: string, from: string, to: string): Promise<boolean> {
    validateBranchName(branch)
    assertNotDefaultBranch(branch)
    if (!get(project, branch)) return updateBranchRef(project, branch, from, to)
    return withVm(project, branch, undefined, async (vm, tool) => {
      const state = await runGitTool(vm, { op: 'state' }, tool)
      noteChanges(project, branch, state.clean)
      if (state.head !== from || !state.clean) return false
      if (!(await updateBranchRef(project, branch, from, to))) return false
      try {
        await runGitTool(vm, { op: 'reset', remote: remoteUrl(project), branch }, tool)
      } catch (err) {
        console.error(`Resetting workspace ${project}/${branch} after a merge failed`, err)
        await git(['--git-dir', repoPath(host, project), 'update-ref', `refs/heads/${branch}`, from, to]).catch(() => {})
        publishChange(host.db, { kind: 'branches', project })
        return false
      }
      return true
    }).catch((err: unknown) => {
      if (err instanceof ProjectError) return false
      throw err
    })
  }

  async function updateBranchRef(project: string, branch: string, from: string, to: string): Promise<boolean> {
    try {
      await git(['--git-dir', repoPath(host, project), 'update-ref', `refs/heads/${branch}`, to, from])
    } catch (err) {
      if (err instanceof GitError) return false
      throw err
    }
    publishChange(host.db, { kind: 'branches', project })
    return true
  }

  // Uncommitted changes in the workspace, including new files.
  function diff(project: string, branch: string): Promise<string> {
    if (!get(project, branch)) return Promise.resolve('')
    return withVm(project, branch, undefined, async (vm, tool) => {
      const result = await runGitTool(vm, { op: 'diff' }, tool)
      noteChanges(project, branch, result.diff === '')
      return result.diff
    })
  }

  // Uncommitted changes as `git status --porcelain` lines.
  function changes(project: string, branch: string): Promise<string[]> {
    if (!get(project, branch)) return Promise.resolve([])
    return withVm(project, branch, undefined, async (vm, tool) => {
      const result = await runGitTool(vm, { op: 'changes' }, tool)
      noteChanges(project, branch, result.total === 0)
      return result.lines
    })
  }

  // `command` sessions are the ones for commands that can change files, as
  // opposed to the host's own tool calls.
  function newSession(project: string, branch: string, agent: Agent, command = false): WorkspaceSession {
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, { project, branch, agent, command })
    return { env: { [command ? SESSION_ENV : TOOL_SESSION_ENV]: token }, close: () => void sessions.delete(token) }
  }

  // Open while a command runs for `agent` in the workspace VM. The command can
  // change any file.
  function openSession(project: string, branch: string, agent: Agent): WorkspaceSession {
    markDirty(project, branch)
    return newSession(project, branch, agent, true)
  }

  // Only sessions of commands act as the agent. `tool` also accepts the
  // host's tool sessions, for routes that only push to the branch.
  function sessionAgent(project: string, branch: string, token: string, { tool = false } = {}): Agent | undefined {
    const session = sessions.get(token)
    if (!session || session.project !== project || session.branch !== branch) return undefined
    return session.command || tool ? session.agent : undefined
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
    start,
    stop,
    stopIdle,
    stopIfIdle,
    stopAll,
    remove,
    deleteBranch,
    touch,
    commit,
    diff,
    changes,
    files,
    isCommitted,
    moveBranch,
    openSession,
    sessionAgent,
    resetStatuses,
  }
}
