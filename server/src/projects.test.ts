import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { git, HOBWORK_IDENTITY } from './git.ts'
import { repoPath } from './host.ts'
import {
  ALLOW_MAIN_ENV,
  createProject,
  getProject,
  listProjects,
  validateProjectName,
} from './projects.ts'
import { createTestHost } from './test-host.ts'

let host: ReturnType<typeof createTestHost>

beforeEach(() => {
  host = createTestHost()
})

afterEach(() => {
  host.dispose()
})

test.each(['filament', 'sleep-alarms', 'ha2', '3d-printer'])('accepts name %s', (name) => {
  expect(() => validateProjectName(name)).not.toThrow()
})

test.each(['', 'Filament', 'sleep_alarms', '-a', 'a-', 'a--b', 'a.b', 'a/b', 'x'.repeat(65)])(
  'rejects name %j',
  (name) => {
    expect(() => validateProjectName(name)).toThrow('Invalid project name')
  },
)

test('creates a bare repo with the template committed on main', async () => {
  const project = await createProject(host, 'filament')
  expect(project).toMatchObject({ name: 'filament', defaultBranch: 'main' })

  const repo = repoPath(host, 'filament')
  expect(existsSync(join(repo, 'hooks', 'pre-receive'))).toBe(true)
  expect(await git(['--git-dir', repo, 'log', '--format=%an|%cn|%s', 'main'])).toBe(
    'Hobwork|Hobwork|Create project from template\n',
  )
  const files = (await git(['--git-dir', repo, 'ls-tree', '-r', '--name-only', 'main'])).split('\n')
  expect(files).toEqual(
    expect.arrayContaining([
      '.gitignore',
      'AGENTS.md',
      'hobwork.json',
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'migrations/.gitkeep',
      'src/greeting-route.ts',
      'tests/handlers.test.ts',
      'ui/index.html',
    ]),
  )
  const pkg = JSON.parse(await git(['--git-dir', repo, 'show', 'main:package.json']))
  expect(pkg.name).toBe('filament')
  expect(Object.keys(pkg.scripts)).toEqual(['typecheck', 'lint', 'test', 'build'])
})

test('lists and gets projects', async () => {
  await createProject(host, 'b-project')
  await createProject(host, 'a-project')
  expect(listProjects(host).map((p) => p.name)).toEqual(['a-project', 'b-project'])
  expect(getProject(host, 'a-project')?.name).toBe('a-project')
  expect(getProject(host, 'missing')).toBeUndefined()
})

test('rejects duplicates without touching the existing repo', async () => {
  await createProject(host, 'filament')
  await expect(createProject(host, 'filament')).rejects.toThrow('already exists')
  expect(existsSync(repoPath(host, 'filament'))).toBe(true)
})

test('rejects invalid names before creating anything', async () => {
  await expect(createProject(host, 'Bad Name')).rejects.toThrow('Invalid project name')
  expect(listProjects(host)).toEqual([])
})

test('the pre-receive hook lets only the host update main', async () => {
  await createProject(host, 'filament')
  const repo = repoPath(host, 'filament')
  const work = mkdtempSync(join(tmpdir(), 'hobwork-hook-'))
  try {
    await git(['clone', '--quiet', repo, work])
    writeFileSync(join(work, 'x.txt'), 'x\n')
    await git(['add', '.'], { cwd: work })
    await git(['commit', '--quiet', '-m', 'Merge'], { cwd: work, env: HOBWORK_IDENTITY })
    await expect(git(['push', '--quiet', 'origin', 'main'], { cwd: work })).rejects.toThrow(
      'Pushing to main is not allowed',
    )
    await git(['push', '--quiet', 'origin', 'main'], { cwd: work, env: ALLOW_MAIN_ENV })
    expect(await git(['--git-dir', repo, 'log', '-1', '--format=%s', 'main'])).toBe('Merge\n')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
