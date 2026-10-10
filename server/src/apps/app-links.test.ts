import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, requireProject } from '../projects.ts'
import { createRuntime, type Runtime } from '../runtime/runtime.ts'
import { fakeRuntimeSandboxes } from '../runtime/test-sandbox.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { sendTo, startTestApp } from '../test-web.ts'
import { recordVersion } from '../versions.ts'

vi.setConfig({ testTimeout: 30_000 })

const RESERVED = [
  { '/': '/api/*', exclude: true },
  { '/': '/_hobwork/*', exclude: true },
  { '/': '/theme/*', exclude: true },
  { '/': '/.well-known/*', exclude: true },
]

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let runtime: Runtime

beforeEach(async () => {
  host = createTestHost()
  runtime = createRuntime(host, { createSandbox: fakeRuntimeSandboxes().factory, image: '/nonexistent-image', startBuildVm: startHostPipelineVm })
  app = await startTestApp(host, { runtime, web: { appleAppId: 'ABCDE12345.example.app' } })
  const hobs: Record<string, unknown> = {
    filament: { static: { '/photos': { dir: 'photos' } }, appLinks: { include: ['/spool/*', '/bin/?'], exclude: ['/spool/print'] } },
    sleep: {},
  }
  for (const [name, config] of Object.entries(hobs)) {
    await createProject(host, name)
    const commit = await seedMain(host, name, { 'package.json': fakePackageJson({ build: 'mkdir -p dist' }), 'hobwork.json': JSON.stringify(config) })
    recordVersion(host, { projectId: requireProject(host, name).id, commit, summary: 'Links' })
  }
})

afterEach(async () => {
  await app.close()
  await runtime.stop()
  host.dispose()
})

async function aasa(origin: string) {
  const res = await sendTo(app.base, `${origin}/.well-known/apple-app-site-association`)
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toBe('application/json')
  return JSON.parse(res.body) as { applinks: { details: { appIDs: string[]; components: unknown[] }[] } }
}

test('each hob origin serves its own link rules without a session, never for host paths or static files', async () => {
  expect((await aasa('http://filament.apps.hobwork.test')).applinks.details).toEqual([
    {
      appIDs: ['ABCDE12345.example.app'],
      components: [
        ...RESERVED,
        { '/': '/photos', exclude: true },
        { '/': '/photos/*', exclude: true },
        { '/': '/spool/print', exclude: true },
        { '/': '/spool/*' },
        { '/': '/bin/?' },
      ],
    },
  ])
  expect((await aasa('http://sleep.apps.hobwork.test')).applinks.details[0]!.components).toEqual([...RESERVED, { '/': '/*' }])
})

test('the apps host serves the rules every hob shares', async () => {
  expect((await aasa('http://apps.hobwork.test')).applinks.details[0]!.components).toEqual([...RESERVED, { '/': '/*' }])
})
