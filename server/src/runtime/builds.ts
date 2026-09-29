import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { git } from '../git.ts'
import { repoPath, type Host } from '../host.ts'
import { truncateMiddle } from '../mcp/output.ts'
import { extraDependencies } from '../platform.ts'
import { checkInstallConfig, explainFrozenInstallFailure } from '../pipeline/pnpm-settings.ts'
import { checkout, FROZEN_INSTALL, MISSING_LOCKFILE, readBlob, readInstallConfig, type StartPipelineVm } from '../pipeline/runner.ts'

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

// The build was written by project code, and the runtime VM mounts the copy, so
// a symlink or device in it could expose host files to the VM. Anything that is
// not a directory or a regular file is refused, and files are opened with
// O_NOFOLLOW so a link swapped in after the check is refused too.
function copyTree(from: string, to: string, budget: { bytes: number; root: string }) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const source = join(from, entry)
    const stat = lstatSync(source)
    if (stat.isDirectory()) copyTree(source, join(to, entry), budget)
    else if (stat.isFile()) copyFile(source, join(to, entry), budget)
    else throw new BuildError(`The build output contains ${describeEntry(stat)} at ${relative(budget.root, source)}`)
  }
}

function describeEntry(stat: Stats): string {
  return stat.isSymbolicLink() ? 'a symbolic link' : 'a file that is not a regular file'
}

function copyFile(source: string, target: string, budget: { bytes: number; root: string }) {
  let input: number
  try {
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    throw new BuildError(`The build output contains a file that cannot be copied: ${relative(budget.root, source)} (${(err as Error).message})`)
  }
  try {
    if (!fstatSync(input).isFile()) {
      throw new BuildError(`The build output contains a file that is not a regular file at ${relative(budget.root, source)}`)
    }
    const output = openSync(target, 'wx', 0o644)
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024)
      for (let n = readSync(input, chunk, 0, chunk.length, null); n > 0; n = readSync(input, chunk, 0, chunk.length, null)) {
        budget.bytes += n
        if (budget.bytes > MAX_BUILD_BYTES) {
          throw new BuildError(`The build output is larger than ${MAX_BUILD_BYTES / 1024 / 1024} MB`)
        }
        writeSync(output, chunk, 0, n)
      }
    } finally {
      closeSync(output)
    }
  } finally {
    closeSync(input)
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
    const stat = lstatSync(dist, { throwIfNoEntry: false })
    if (stat && !stat.isDirectory()) throw new BuildError('dist must be a directory')
    if (stat) copyTree(dist, join(staging, 'out'), { bytes: 0, root: dist })
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
      const problems = checkInstallConfig(await readInstallConfig(gitDir, commit))
      if (problems.length) throw new BuildError(problems.join('\n'))
      const pkg = JSON.parse((await readBlob(gitDir, commit, 'package.json')) ?? '{}')
      const hasExtras = extraDependencies(pkg).length > 0
      if (hasExtras && (await readBlob(gitDir, commit, 'pnpm-lock.yaml')) === undefined) throw new BuildError(MISSING_LOCKFILE)
      const dir = await checkout(gitDir, commit, tmp)
      vm = await startVm({ dir, project, kind: 'build' })
      const commands = [...(hasExtras ? [FROZEN_INSTALL] : []), 'pnpm run build']
      for (const command of commands) {
        const result = await vm.exec(command, { cwd: '.', timeoutMs: BUILD_TIMEOUT_MS })
        if (result.exitCode !== 0) {
          const output = result.stdout + result.stderr
          const hint = explainFrozenInstallFailure(output)
          throw new BuildError(
            `${command} failed with exit code ${result.exitCode}:\n${truncateMiddle(output, 4000)}${hint ? `\n${hint}` : ''}`,
          )
        }
      }
      if (vm.iconsCommand) {
        // Merges refuse wrong icons, so this is a branch preview's icon or a
        // host problem. The build works without icons.
        const icons = await vm.exec(`${vm.iconsCommand} ${project}`, { cwd: '.', timeoutMs: BUILD_TIMEOUT_MS })
        if (icons.exitCode !== 0) console.error(`Rendering the icon of ${project} failed: ${icons.stdout}${icons.stderr}`)
      }
      // Stopped first so build code cannot change dist/ while it is copied.
      const running = vm
      await running.stop()
      vm = undefined
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
