import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git, HOBWORK_IDENTITY } from './git.ts'
import { repoPath, type Host } from './host.ts'
import { ALLOW_MAIN_ENV, DEFAULT_BRANCH } from './projects.ts'

export type Files = Record<string, string>

// Stands in for the template toolchain: every pipeline script is a shell
// one-liner, so tests run without installing TypeScript, Vitest or Vite.
export function fakePackageJson(scripts: Record<string, string> = {}): string {
  return JSON.stringify({
    name: 'fake',
    private: true,
    scripts: { typecheck: 'true', lint: 'true', test: 'echo all tests passed', build: 'true', ...scripts },
  })
}

export const FAKE_PROJECT: Files = {
  'package.json': fakePackageJson(),
  'hobwork.json': '{}',
  'src/a.ts': 'export const a = 1\n',
}

// Replaces main's tree with `files`, the way only host code can.
export function seedMain(host: Host, project: string, files: Files = FAKE_PROJECT): Promise<string> {
  return seedBranch(host, project, DEFAULT_BRANCH, files)
}

// Commits `files` as the whole tree of `branch`, which starts from main if it
// does not exist yet.
export async function seedBranch(host: Host, project: string, branch: string, files: Files): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'hobwork-seed-'))
  try {
    const work = join(tmp, 'work')
    await git(['clone', '--quiet', '--branch', DEFAULT_BRANCH, repoPath(host, project), work])
    await git(['checkout', '--quiet', '-B', branch, `origin/${branch}`], { cwd: work }).catch(() =>
      git(['checkout', '--quiet', '-B', branch], { cwd: work }),
    )
    await git(['rm', '--quiet', '-r', '.'], { cwd: work })
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true })
      writeFileSync(join(work, path), content)
    }
    await git(['add', '--all'], { cwd: work })
    await git(['commit', '--quiet', '-m', 'Seed fake project'], { cwd: work, env: HOBWORK_IDENTITY })
    await git(['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd: work, env: ALLOW_MAIN_ENV })
    return (await git(['rev-parse', 'HEAD'], { cwd: work })).trim()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
