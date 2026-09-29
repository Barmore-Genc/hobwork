// Runs against the dev instance from dev/homeassistant (see its README):
// HOBWORK_HA_TESTS=1 pnpm --filter @hobwork/server test src/runtime/homeassistant
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createHomeAssistant, type HomeAssistant } from '../homeassistant/client.ts'
import { createTriggerRegistry } from '../homeassistant/triggers.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { createProject, requireProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedMain } from '../test-project.ts'
import { recordVersion } from '../versions.ts'
import { triggerRegistryLogger } from './homeassistant.ts'
import { listInvocations, queryLogs } from './logs.ts'
import { createRuntime, type Runtime } from './runtime.ts'
import { fakeRuntimeSandboxes } from './test-sandbox.ts'

function connection(): { url: string; token: string } {
  const envFile = resolve(import.meta.dirname, '../../../dev/homeassistant/.env.local')
  const vars: Record<string, string | undefined> = { ...process.env }
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) vars[line.slice(0, i)] ??= line.slice(i + 1)
    }
  }
  const { HOBWORK_HA_URL: url, HOBWORK_HA_TOKEN: token } = vars
  if (!url || !token) throw new Error('Set HOBWORK_HA_URL and HOBWORK_HA_TOKEN or run node dev/homeassistant/setup.ts')
  return { url, token }
}

const SWITCH = 'input_boolean.test_switch'

describe.runIf(process.env.HOBWORK_HA_TESTS === '1')('Home Assistant triggers run handlers', () => {
  let ha: HomeAssistant
  let host: ReturnType<typeof createTestHost>
  let runtime: Runtime

  beforeAll(async () => {
    const conn = connection()
    ha = createHomeAssistant({ connection: () => conn, logger: { info() {}, warn() {}, error() {} } })
    ha.start()
    await ha.waitUntilConnected()
    host = createTestHost()
    const triggers = createTriggerRegistry({
      ha,
      invoke: async (project, name, variables) => {
        await runtime.invoke(project, { kind: 'trigger', name, manual: false, payload: variables })
      },
      logger: triggerRegistryLogger(host),
    })
    runtime = createRuntime(host, {
      createSandbox: fakeRuntimeSandboxes().factory,
      image: '/nonexistent-image',
      startBuildVm: startHostPipelineVm,
      triggers,
    })
  })

  afterAll(async () => {
    await runtime?.stop()
    ha?.stop()
    host?.dispose()
  })

  test('a state change in HA invokes the trigger handler with the trigger variables', async () => {
    await createProject(host, 'lights')
    const commit = await seedMain(host, 'lights', {
      'package.json': fakePackageJson({ build: 'mkdir -p dist/handlers/src && cp switch.js dist/handlers/src/' }),
      'hobwork.json': JSON.stringify({
        triggers: {
          'test-switch': { homeassistant: { trigger: 'state', entity_id: SWITCH }, handler: 'src/switch.ts' },
          broken: { homeassistant: { trigger: 'no_such_trigger' }, handler: 'src/switch.ts' },
        },
      }),
      'switch.js': `export default async (ctx) => console.log('switch is', ctx.payload.trigger.to_state.state)`,
    })
    const version = recordVersion(host, { projectId: requireProject(host, 'lights').id, commit, summary: 'Switch' })
    await runtime.deploy({ project: 'lights', version: version.number, commit, reason: 'merge' })

    const before = (await ha.getState(SWITCH))?.state
    const next = before === 'on' ? 'off' : 'on'
    await ha.callService('input_boolean', next === 'on' ? 'turn_on' : 'turn_off', undefined, { entity_id: SWITCH })

    await vi.waitFor(
      () => expect(listInvocations(host, { project: 'lights', kind: 'trigger', status: 'ok', limit: 5 })).toHaveLength(1),
      { timeout: 10_000 },
    )
    const [invocation] = listInvocations(host, { project: 'lights', kind: 'trigger', limit: 5 })
    expect(invocation).toMatchObject({ name: 'test-switch', status: 'ok', manual: false })
    await vi.waitFor(() => {
      const messages = queryLogs(host, { project: 'lights', invocationId: invocation!.id, limit: 5 }).map((l) => l.message)
      expect(messages).toEqual([`switch is ${next}`])
    })
    const refused = queryLogs(host, { project: 'lights', limit: 50 }).find((l) => l.event === 'trigger')
    expect(refused?.message).toContain('broken')
  })
})
