import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import type { StartPipelineVm } from '../pipeline/runner.ts'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { createBuilder } from './builds.ts'

vi.setConfig({ testTimeout: 30_000 })

let host: ReturnType<typeof createTestHost>

beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
})

afterEach(() => host.dispose())

function withIcons(iconsCommand: string): StartPipelineVm {
  return async (options) => ({ ...(await startHostPipelineVm(options)), iconsCommand })
}

async function build(startVm: StartPipelineVm): Promise<string> {
  const commit = await seedMain(host, 'filament', {
    'package.json': fakePackageJson({ build: 'mkdir -p dist && printf page > dist/index.html' }),
    'hobwork.json': '{}',
  })
  return createBuilder(host, startVm).ensure('filament', commit)
}

test('renders the icon into the build', async () => {
  const dir = await build(withIcons(`sh -c 'mkdir -p dist/_hobwork/icons && printf "$0" > dist/_hobwork/icons/icon-32.png'`))
  expect(readFileSync(join(dir, '_hobwork/icons/icon-32.png'), 'utf8')).toBe('filament')
})

test('a build whose icon fails is kept without icons', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const dir = await build(withIcons('false'))
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('page')
  expect(existsSync(join(dir, '_hobwork'))).toBe(false)
})
