import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from './agents.ts'
import type { User } from './auth/users.ts'
import { git, GitError, HOBWORK_IDENTITY } from './git.ts'
import { repoPath, type Host } from './host.ts'
import { runPipeline, type PipelineOptions, type PipelineRun } from './pipeline/runner.ts'
import { ALLOW_MAIN_ENV, DEFAULT_BRANCH, ProjectError, requireProject } from './projects.ts'
import { assertNotDefaultBranch, branchExists, validateBranchName } from './repo.ts'
import { getVersion, recordVersion, type Version } from './versions.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from './workspaces.ts'

export type Deployment = {
  project: string
  version: number
  commit: string
  reason: 'merge' | 'restore'
}

// Called after main moved to a new version. The runtime implements it.
export type Deploy = (deployment: Deployment) => Promise<void>

export type MergeResult =
  | {
      status: 'merged'
      version: Version
      run: PipelineRun
      // False when the branch or its workspace changed while the merge ran, so
      // it was left as it was instead of being reset onto the new main.
      branchReset: boolean
      deployError?: string
    }
  | { status: 'conflict'; files: string[]; output: string }
  | { status: 'failed'; run: PipelineRun }

export type RestoreResult = { version: Version; deployError?: string }

export type Delivery = ReturnType<typeof createDelivery>

export type DeliveryOptions = {
  workspaces: WorkspaceManager<ExecWorkspaceVm>
  // Without a pipeline VM backend, merge refuses. Restore does not run the pipeline.
  pipeline?: PipelineOptions
  deploy?: Deploy
}

function authorEnv(agent: Agent): Record<string, string> {
  return {
    ...HOBWORK_IDENTITY,
    GIT_AUTHOR_NAME: agent.name,
    GIT_AUTHOR_EMAIL: `agent-${agent.id}@hobwork.local`,
  }
}

function userEnv(user: User): Record<string, string> {
  return {
    ...HOBWORK_IDENTITY,
    GIT_AUTHOR_NAME: user.name,
    GIT_AUTHOR_EMAIL: user.email ?? `user-${user.id}@hobwork.local`,
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createDelivery(host: Host, options: DeliveryOptions) {
  const deploy = options.deploy ?? (async () => {})
  const queues = new Map<string, Promise<unknown>>()

  // Everything that moves main runs one at a time per project, so each merge is
  // tested against the main it lands on.
  function serialized<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(project) ?? Promise.resolve()).catch(() => {}).then(fn)
    queues.set(project, run)
    void run
      .catch(() => {})
      .finally(() => {
        if (queues.get(project) === run) queues.delete(project)
      })
    return run
  }

  async function deployVersion(deployment: Deployment): Promise<string | undefined> {
    try {
      await deploy(deployment)
      return undefined
    } catch (err) {
      console.error(`Deploying ${deployment.project} version ${deployment.version} failed`, err)
      return errorMessage(err)
    }
  }

  // Squashes the branch into one commit and rebases it onto main in a temporary
  // clone. Squashing first means only the branch's end result has to apply, not
  // every intermediate commit.
  async function buildCandidate(
    work: string,
    branch: string,
    summary: string,
    agent: Agent,
  ): Promise<{ commit: string; branchHead: string } | { conflict: string[]; output: string }> {
    const inWork = (args: string[], env?: Record<string, string>, input?: string) =>
      git(args, { cwd: work, env, input })
    const main = (await inWork(['rev-parse', `origin/${DEFAULT_BRANCH}`])).trim()
    const branchHead = (await inWork(['rev-parse', 'HEAD'])).trim()
    const base = (await inWork(['merge-base', main, branchHead])).trim()
    const env = authorEnv(agent)
    await inWork(['reset', '--quiet', '--soft', base])
    await inWork(['commit', '--quiet', '--allow-empty', '--no-verify', '--file', '-'], env, summary)
    try {
      await inWork(['rebase', '--quiet', main], env)
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      const files = (await inWork(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
      const output = await inWork(['diff'])
      await inWork(['rebase', '--abort']).catch(() => {})
      return { conflict: files, output: output || err.stderr }
    }
    const commit = (await inWork(['rev-parse', 'HEAD'])).trim()
    if (commit === main || (await inWork(['diff', '--quiet', main, commit]).then(() => true, () => false))) {
      throw new ProjectError(`${branch} has no changes compared to ${DEFAULT_BRANCH}. Commit changes before merging`)
    }
    return { commit, branchHead }
  }

  async function merge(request: { project: string; branch: string; summary: string; agent: Agent }): Promise<MergeResult> {
    const { project, branch, agent } = request
    const summary = request.summary.trim()
    validateBranchName(branch)
    assertNotDefaultBranch(branch)
    const { id: projectId } = requireProject(host, project)
    const pipeline = options.pipeline
    if (!pipeline) throw new ProjectError('This Hobwork host cannot merge: no pipeline VM backend is configured')
    if (!summary) throw new ProjectError('Merge summary must not be empty')

    return serialized(project, async () => {
      if (!(await branchExists(host, project, branch))) {
        throw new ProjectError(`Branch "${branch}" does not exist in ${project}`)
      }
      if (options.workspaces.get(project, branch) && (await options.workspaces.diff(project, branch))) {
        throw new ProjectError(
          `${branch} has uncommitted changes. Merge only takes committed changes: commit them or undo them first`,
        )
      }

      const repo = repoPath(host, project)
      const tmp = mkdtempSync(join(tmpdir(), 'hobwork-merge-'))
      try {
        const work = join(tmp, 'work')
        await git(['clone', '--quiet', '--branch', branch, repo, work])
        const candidate = await buildCandidate(work, branch, summary, agent)
        if ('conflict' in candidate) return { status: 'conflict', files: candidate.conflict, output: candidate.output }

        const run = await runPipeline(host, pipeline, {
          project,
          gitDir: join(work, '.git'),
          commit: candidate.commit,
          branch,
          agentId: agent.id,
        })
        if (run.status !== 'passed') return { status: 'failed', run }

        await git(['push', '--quiet', 'origin', `${candidate.commit}:refs/heads/${DEFAULT_BRANCH}`], {
          cwd: work,
          env: ALLOW_MAIN_ENV,
        })
        const version = recordVersion(host, {
          projectId,
          commit: candidate.commit,
          summary,
          agentId: agent.id,
          pipelineRunId: run.id,
        })
        const branchReset = await options.workspaces.moveBranch(
          project,
          branch,
          candidate.branchHead,
          candidate.commit,
        )
        const deployError = await deployVersion({
          project,
          version: version.number,
          commit: candidate.commit,
          reason: 'merge',
        })
        return { status: 'merged', version, run, branchReset, ...(deployError ? { deployError } : {}) }
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  }

  // Commits the version's tree as a new commit on main. History is never rewritten.
  // Started by an agent over MCP, by a user in the web UI, or by auto-revert
  // with neither, in which case Hobwork is the author.
  async function restore(request: {
    project: string
    version: number
    agent?: Agent
    user?: User
    summary?: string
  }): Promise<RestoreResult> {
    const { project, agent, user } = request
    const { id: projectId } = requireProject(host, project)
    return serialized(project, async () => {
      const target = getVersion(host, project, request.version)
      if (!target) throw new ProjectError(`Version ${request.version} does not exist in ${project}`)
      const repo = repoPath(host, project)
      const inRepo = (args: string[], env?: Record<string, string>, input?: string) =>
        git(['--git-dir', repo, ...args], { env, input })
      const main = (await inRepo(['rev-parse', `refs/heads/${DEFAULT_BRANCH}`])).trim()
      const tree = (await inRepo(['rev-parse', `${target.commit}^{tree}`])).trim()
      if (tree === (await inRepo(['rev-parse', `${main}^{tree}`])).trim()) {
        throw new ProjectError(`${DEFAULT_BRANCH} already has the code of version ${target.number}`)
      }
      const summary = request.summary ?? `Restore version ${target.number}`
      const env = agent ? authorEnv(agent) : user ? userEnv(user) : HOBWORK_IDENTITY
      const commit = (await inRepo(['commit-tree', tree, '-p', main, '-F', '-'], env, summary)).trim()
      await inRepo(['update-ref', `refs/heads/${DEFAULT_BRANCH}`, commit, main])
      const version = recordVersion(host, {
        projectId,
        commit,
        summary,
        agentId: agent?.id,
        userId: user?.id,
        restoredFrom: target.number,
      })
      const deployError = await deployVersion({ project, version: version.number, commit, reason: 'restore' })
      return { version, ...(deployError ? { deployError } : {}) }
    })
  }

  return {
    merge,
    restore,
    // Runs fn while no merge or restore of the project runs, e.g. to delete it.
    exclusive: <T>(project: string, fn: () => Promise<T>): Promise<T> => serialized(project, fn),
  }
}
