import { spawn } from 'node:child_process'
import { ToolError } from './error.ts'

// Git on the workspace checkout, run inside the VM. The checkout has no .git
// entry: the git directory is mounted next to it and named explicitly, so
// nothing the checkout contains changes which repository these commands use.

const MAX_DIFF_BYTES = 1024 * 1024
const MAX_STATUS_LINES = 1000
const MAX_STDERR_CHARS = 2000

export type GitRequest =
  | {
      op: 'commit'
      message: string
      authorName: string
      authorEmail: string
      remote: string
      branch: string
    }
  | { op: 'diff' }
  | { op: 'changes' }
  | { op: 'state' }
  | { op: 'reset'; remote: string; branch: string }

export type GitResponse =
  | { op: 'commit'; committed: false }
  | { op: 'commit'; committed: true; sha: string; clean: boolean }
  | { op: 'diff'; diff: string; truncated: boolean }
  | { op: 'changes'; lines: string[]; total: number }
  | { op: 'state'; head: string; clean: boolean }
  | { op: 'reset' }

type Run = { code: number; stdout: string; stderr: string; truncated: boolean }

function run(args: string[], options: { cwd: string; input?: string; maxBytes?: number; env?: Record<string, string> }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_COMMITTER_NAME: 'Hobwork',
        GIT_COMMITTER_EMAIL: 'hobwork@localhost',
        ...options.env,
      },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let truncated = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (size >= maxBytes) {
        truncated = true
        return
      }
      stdout.push(chunk.subarray(0, maxBytes - size))
      size += chunk.length
      if (size > maxBytes) truncated = true
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((sum, b) => sum + b.length, 0) < MAX_STDERR_CHARS * 4) stderr.push(chunk)
    })
    child.on('error', reject)
    child.stdin.on('error', () => {})
    child.on('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
      }),
    )
    child.stdin.end(options.input ?? '')
  })
}

function sessionArgs(): string[] {
  const token = process.env.HOBWORK_TOOL_SESSION
  return token ? ['-c', `http.extraHeader=x-hobwork-session: ${token}`] : []
}

export async function runGitRequest(workTree: string, request: GitRequest): Promise<GitResponse> {
  const gitDir = process.env.HOBWORK_GIT_DIR
  if (!gitDir) throw new Error('HOBWORK_GIT_DIR is not set')
  // safe.directory: the mounted files can belong to another user than the one running this.
  const base = ['-c', 'safe.directory=*', '--git-dir', gitDir, '--work-tree', workTree]

  async function git(args: string[], options: { input?: string; maxBytes?: number; env?: Record<string, string> } = {}): Promise<Run> {
    const result = await run([...base, ...args], { cwd: workTree, ...options })
    if (result.code !== 0) {
      throw new ToolError(`git ${args.find((a) => !a.startsWith('-')) ?? ''} failed: ${result.stderr.trim().slice(0, MAX_STDERR_CHARS)}`)
    }
    return result
  }

  async function porcelain(): Promise<string[]> {
    const status = await git(['status', '--porcelain', '--untracked-files=all'])
    return status.stdout.split('\n').filter(Boolean)
  }

  switch (request.op) {
    case 'commit': {
      await git(['add', '--all'])
      const status = await git(['status', '--porcelain'])
      if (!status.stdout.trim()) return { op: 'commit', committed: false }
      await git(['commit', '--quiet', '--file', '-'], {
        input: request.message,
        env: { GIT_AUTHOR_NAME: request.authorName, GIT_AUTHOR_EMAIL: request.authorEmail },
      })
      await git([...sessionArgs(), 'push', '--quiet', request.remote, `HEAD:refs/heads/${request.branch}`])
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
      return { op: 'commit', committed: true, sha: head, clean: (await porcelain()).length === 0 }
    }
    case 'diff': {
      await git(['add', '--all'])
      const diff = await git(['diff', '--cached', '--no-ext-diff', 'HEAD'], { maxBytes: MAX_DIFF_BYTES })
      return { op: 'diff', diff: diff.stdout, truncated: diff.truncated }
    }
    case 'changes': {
      const lines = await porcelain()
      return { op: 'changes', lines: lines.slice(0, MAX_STATUS_LINES), total: lines.length }
    }
    case 'state': {
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
      return { op: 'state', head, clean: (await porcelain()).length === 0 }
    }
    case 'reset': {
      const remote = `refs/remotes/origin/${request.branch}`
      await git([...sessionArgs(), 'fetch', '--quiet', request.remote, `+refs/heads/${request.branch}:${remote}`])
      await git(['reset', '--quiet', '--hard', remote])
      return { op: 'reset' }
    }
  }
}
