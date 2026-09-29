// Runs against the dev instance from dev/homeassistant (see its README):
// HOBWORK_HA_TESTS=1 pnpm --filter @hobwork/server test src/runtime/homeassistant
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { grantBranchHa, revokeBranchHa } from '../homeassistant/approvals.ts'
import { createHomeAssistant, type HomeAssistant } from '../homeassistant/client.ts'
import { signedIn } from '../test-web.ts'
import { createTriggerRegistry } from '../homeassistant/triggers.ts'
import { startHostPipelineVm } from '../pipeline/host-backend.ts'
import { setHaServices } from '../homeassistant/services.ts'
import { createProject, requireProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { fakePackageJson, seedBranch, seedMain } from '../test-project.ts'
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
const BUTTON = 'input_button.test_button'
const NUMBER = 'input_number.test_number'

async function release(project: string, files: Record<string, string>) {
  await createProject(host, project)
  setHaServices(host, project, ['input_boolean', 'input_number', 'input_button'], { kind: 'user', name: 'Test' })
  const commit = await seedMain(host, project, {
    'package.json': fakePackageJson({ build: 'mkdir -p dist/handlers/src && cp *.js dist/handlers/src/' }),
    ...files,
  })
  const version = recordVersion(host, { projectId: requireProject(host, project).id, commit, summary: 'Release' })
  await runtime.deploy({ project, version: version.number, commit, reason: 'merge' })
}

let ha: HomeAssistant
let host: ReturnType<typeof createTestHost>
let runtime: Runtime

describe.runIf(process.env.HOBWORK_HA_TESTS === '1')('Home Assistant triggers and actions in handlers', () => {

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
      homeAssistant: ha,
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

  test('a deployed handler toggles an input_boolean with ctx.ha.callService', async () => {
    await release('toggler', {
      'hobwork.json': JSON.stringify({ routes: { 'POST /toggle': { handler: 'src/toggle.ts' } } }),
      'toggle.js': `export default async (ctx) => {
        await ctx.ha.callService('input_boolean', 'toggle', undefined, { entity_id: '${SWITCH}' })
        return (await ctx.ha.getState('${SWITCH}')).state
      }`,
    })
    const before = (await ha.getState(SWITCH))?.state
    const outcome = await runtime.invoke('toggler', { kind: 'route', name: 'POST /toggle', manual: true })
    if (!outcome.ok) throw new Error(outcome.error.message)
    const after = (await ha.getState(SWITCH))?.state
    expect(after).toBe(before === 'on' ? 'off' : 'on')
    expect(JSON.parse(Buffer.from(outcome.response.body, 'base64').toString())).toBe(after)
    const logged = queryLogs(host, { project: 'toggler', invocationId: outcome.invocationId, limit: 10 }).map((l) => l.message)
    expect(logged).toContain(`Home Assistant: input_boolean.toggle target {"entity_id":"${SWITCH}"}`)
  })

  test('a trigger on a button runs a handler that calls a service and fires an event', async () => {
    const value = 20 + Math.floor(Math.random() * 60)
    await release('button', {
      'hobwork.json': JSON.stringify({
        triggers: { pressed: { homeassistant: { trigger: 'state', entity_id: BUTTON }, handler: 'src/pressed.ts' } },
      }),
      'pressed.js': `export default async (ctx) => {
        await ctx.ha.callService('input_number', 'set_value', { value: ${value} }, { entity_id: '${NUMBER}' })
        await ctx.ha.fireEvent('hobwork_handler_event', { from: ctx.payload.trigger.entity_id })
      }`,
    })
    const events: unknown[] = []
    const unsubscribe = await ha.subscribeTrigger({ trigger: 'event', event_type: 'hobwork_handler_event' }, (variables) => {
      events.push((variables.trigger as { event?: { data?: unknown } }).event?.data)
    })
    try {
      await ha.callService('input_button', 'press', undefined, { entity_id: BUTTON })
      await vi.waitFor(async () => expect((await ha.getState(NUMBER))?.state).toBe(`${value}.0`), { timeout: 10_000 })
      await vi.waitFor(() => expect(events).toEqual([{ from: BUTTON }]), { timeout: 5_000 })
      expect(listInvocations(host, { project: 'button', kind: 'trigger', limit: 5 })).toMatchObject([{ name: 'pressed', status: 'ok' }])
    } finally {
      await unsubscribe()
    }
  })

  test('a branch preview reads states, and calls services only after a person allows it', async () => {
    await release('preview', {
      'hobwork.json': JSON.stringify({}),
      'noop.js': 'export default async () => {}',
    })
    const branchFiles = {
      'package.json': fakePackageJson({ build: 'mkdir -p dist/handlers/src && cp *.js dist/handlers/src/' }),
      'hobwork.json': JSON.stringify({
        routes: { 'POST /toggle': { handler: 'src/toggle.ts' } },
        triggers: { switched: { homeassistant: { trigger: 'state', entity_id: SWITCH }, handler: 'src/toggle.ts' } },
      }),
      'toggle.js': `export default async (ctx) => {
        const before = (await ctx.ha.getState('${SWITCH}')).state
        try {
          await ctx.ha.callService('input_boolean', 'toggle', undefined, { entity_id: '${SWITCH}' })
          return { before, toggled: true }
        } catch (err) {
          return { before, toggled: false, code: err.code }
        }
      }`,
    }
    await seedBranch(host, 'preview', 'try-lights', branchFiles)
    const toggle = async () => {
      const outcome = await runtime.invoke('preview', { kind: 'route', name: 'POST /toggle', manual: true, branch: 'try-lights' })
      if (!outcome.ok) throw new Error(outcome.error.message)
      return { id: outcome.invocationId, body: JSON.parse(Buffer.from(outcome.response.body, 'base64').toString()) }
    }

    const before = (await ha.getState(SWITCH))?.state
    const denied = await toggle()
    expect(denied.body).toEqual({ before, toggled: false, code: 'not_approved' })
    expect((await ha.getState(SWITCH))?.state).toBe(before)
    const warning = queryLogs(host, { project: 'preview', invocationId: denied.id, limit: 10 }).find((l) => l.level === 'warn')
    expect(warning?.message).toContain('Home Assistant: denied input_boolean.toggle')

    grantBranchHa(host, 'preview', 'try-lights', { userId: signedIn(host).user.id })
    expect((await toggle()).body).toEqual({ before, toggled: true })
    const after = (await ha.getState(SWITCH))?.state
    expect(after).toBe(before === 'on' ? 'off' : 'on')

    // The branch's trigger is not subscribed: the toggle above started nothing.
    await new Promise((r) => setTimeout(r, 1000))
    expect(listInvocations(host, { project: 'preview', kind: 'trigger', limit: 5 })).toEqual([])

    revokeBranchHa(host, 'preview', 'try-lights')
    expect((await toggle()).body).toMatchObject({ toggled: false, code: 'not_approved' })
  })
})
