import { spawn } from 'node:child_process'

export type GitOptions = {
  cwd?: string
  env?: Record<string, string>
  input?: string
}

export class GitError extends Error {
  readonly code: number | null
  readonly stderr: string

  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`)
    this.code = code
    this.stderr = stderr
  }
}

// The host's git behaviour must not depend on the machine's user or system config
// (signing, hooks paths, LFS filters, credential helpers).
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  }
}

export const HOBWORK_IDENTITY = {
  GIT_AUTHOR_NAME: 'Hobwork',
  GIT_AUTHOR_EMAIL: 'hobwork@localhost',
  GIT_COMMITTER_NAME: 'Hobwork',
  GIT_COMMITTER_EMAIL: 'hobwork@localhost',
}

export function git(args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: options.cwd, env: gitEnv(options.env) })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    // Commands that never read stdin can exit before we write it; the exit code is what matters.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
      else reject(new GitError(args, code, Buffer.concat(stderr).toString('utf8')))
    })
    child.stdin.end(options.input ?? '')
  })
}
