import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git.ts'
import { repoPath, type Host } from '../host.ts'
import { truncateMiddle } from '../mcp/output.ts'
import { extraDependencies } from '../platform.ts'
import { checkout, readBlob, type StartPipelineVm } from '../pipeline/runner.ts'

// A build is the project's dist/ after `pnpm run build`. Builds are keyed by
// git tree rather than commit: a restore commits an old tree as a new commit,
// and finds the old version's build already there.
const MAX_BUILD_BYTES = 256 * 1024 * 1024
const BUILD_TIMEOUT_MS = 10 * 60 * 1000

export class BuildError extends Error {}

export function projectBuildsDir(host: Host, project: string): string {
  return join(host.dataDir, 'builds', project)
}

export function buildDir(host: Host, project: string, tree: string): string {
  return join(projectBuildsDir(host, project), tree)
}

export async function treeOf(gitDir: string, commit: string): Promise<string> {
  return (await git(['--git-dir', gitDir, 'rev-parse', `${commit}^{tree}`])).trim()
}

// Copies only directories and regular files. The build was written by project
// code, and the runtime VM mounts the copy, so a symlink in it could expose
// host files to the VM.
function copyTree(from: string, to: string, budget: { bytes: number }) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const source = join(from, entry)
    const stat = lstatSync(source)
    if (stat.isDirectory()) copyTree(source, join(to, entry), budget)
    else if (stat.isFile()) {
      budget.bytes += stat.size
      if (budget.bytes > MAX_BUILD_BYTES) {
        throw new BuildError(`The build output is larger than ${MAX_BUILD_BYTES / 1024 / 1024} MB`)
      }
      copyFileSync(source, join(to, entry))
    }
  }
}

// Stores `dir`/dist as the build of `commit`. A checkout without dist/ stores
// an empty build: the version then deploys with no handlers.
export async function saveBuild(
  host: Host,
  build: { project: string; gitDir: string; commit: string; dir: string },
): Promise<string> {
  const target = buildDir(host, build.project, await treeOf(build.gitDir, build.commit))
  if (existsSync(target)) return target
  const parent = projectBuildsDir(host, build.project)
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.staging-'))
  try {
    const dist = join(build.dir, 'dist')
    const stat = existsSync(dist) ? lstatSync(dist) : undefined
    if (stat?.isDirectory()) copyTree(dist, join(staging, 'out'), { bytes: 0 })
    else mkdirSync(join(staging, 'out'))
    if (!existsSync(target)) renameSync(join(staging, 'out'), target)
    return target
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

// Builds a commit that has no stored build (a restore of a version from before
// builds were kept, or the template commit) in a fresh VM: install extras, then
// `pnpm run build`. Tests are not run; the pipeline ran them when the version
// was merged.
export function createBuilder(host: Host, startVm: StartPipelineVm | undefined) {
  const running = new Map<string, Promise<string>>()

  async function build(project: string, commit: string, tree: string): Promise<string> {
    if (!startVm) throw new BuildError('This Hobwork host cannot build: no pipeline VM backend is configured')
    const gitDir = repoPath(host, project)
    const tmp = mkdtempSync(join(tmpdir(), 'hobwork-build-'))
    let vm: Awaited<ReturnType<StartPipelineVm>> | undefined
    try {
      const dir = await checkout(gitDir, commit, tmp)
      vm = await startVm({ dir })
      const pkg = JSON.parse((await readBlob(gitDir, commit, 'package.json')) ?? '{}')
      const commands = [...(extraDependencies(pkg).length ? ['pnpm install'] : []), 'pnpm run build']
      for (const command of commands) {
        const result = await vm.exec(command, { cwd: '.', timeoutMs: BUILD_TIMEOUT_MS })
        if (result.exitCode !== 0) {
          throw new BuildError(
            `${command} failed with exit code ${result.exitCode}:\n${truncateMiddle(result.stdout + result.stderr, 4000)}`,
          )
        }
      }
      await saveBuild(host, { project, gitDir, commit, dir })
      return buildDir(host, project, tree)
    } finally {
      await vm?.stop().catch((err: unknown) => console.error('Stopping build VM failed', err))
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  return {
    async ensure(project: string, commit: string): Promise<string> {
      const tree = await treeOf(repoPath(host, project), commit)
      const dir = buildDir(host, project, tree)
      if (existsSync(dir)) return dir
      const key = `${project}\0${tree}`
      let pending = running.get(key)
      if (!pending) {
        pending = build(project, commit, tree).finally(() => running.delete(key))
        running.set(key, pending)
      }
      return pending
    },
  }
}

export type Builder = ReturnType<typeof createBuilder>
