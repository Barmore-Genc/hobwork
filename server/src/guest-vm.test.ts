import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProjectData } from './data/project-data.ts'
import { createWorkspaceEnvironment } from './data/workspace-environment.ts'
import { pipelineVmBackend, workspaceVmBackend } from './guest-vm.ts'
import type { Devices } from './devices/devices.ts'
import type { HomeAssistant } from './homeassistant/client.ts'
import { createProject } from './projects.ts'
import { queryLogs } from './runtime/logs.ts'
import { createSecretStore } from './secrets.ts'
import { createTestHost } from './test-host.ts'
import type { ExecOptions, Sandbox, SandboxOptions, SpawnOptions } from './sandbox/sandbox.ts'
import type { Workspace } from './workspaces.ts'

type FakeSandbox = Sandbox & {
  options: SandboxOptions
  commands: { command: string; options: ExecOptions | SpawnOptions }[]
  stopped: boolean
  // Ends the process started last with spawn.
  exit?: (result: { exitCode: number; signal?: number }) => void
}

let dir: string
const SESSION = { 'x-hobwork-session': 'good' }
const hasSession = (_workspace: unknown, token: string) => token === 'good'

let sandboxes: FakeSandbox[]

async function createSandbox(options: SandboxOptions): Promise<FakeSandbox> {
  const sandbox: FakeSandbox = {
    id: String(sandboxes.length),
    options,
    commands: [],
    stopped: false,
    exec(command, execOptions = {}) {
      sandbox.commands.push({ command, options: execOptions })
      execOptions.onOutput?.({ stream: 'stdout', text: `ran ${command}\n` })
      execOptions.onOutput?.({ stream: 'stderr', text: 'warning\n' })
      const exitCode = command === 'false' ? 1 : 0
      return {
        result: Promise.resolve({ exitCode, timedOut: false, killed: false, stdout: '', stderr: '' }),
        kill: async () => {},
      }
    },
    spawn(command, spawnOptions) {
      sandbox.commands.push({ command, options: spawnOptions })
      const input: string[] = []
      const result = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
        sandbox.exit = resolve
      })
      return {
        result,
        write: (data) => void input.push(Buffer.from(data).toString()),
        end: () => spawnOptions.onData('stdout', Buffer.from(input.join(''))),
        resize: () => {},
        kill: async () => {},
      }
    },
    ingress: async () => '',
    readFile: async () => Buffer.from(''),
    writeFile: async () => {},
    hostPid: () => null,
    async stop() {
      sandbox.stopped = true
    },
  }
  sandboxes.push(sandbox)
  return sandbox
}

function workspace(): Workspace {
  return {
    id: 1,
    project: 'filament',
    branch: 'spools',
    status: 'starting',
    dir,
    createdAt: '',
    lastUsedAt: '',
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobwork-guest-vm-test-'))
  sandboxes = []
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('workspace VMs mount the checkout with node_modules on the VM disk', async () => {
  writeFileSync(join(dir, 'hobwork.json'), '{\n  // Spoolman\n  "egress": ["api.example.com",],\n}\n')
  const vm = await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  const [sandbox] = sandboxes
  expect(sandbox?.options).toMatchObject({
    image: '/image',
    cpus: 4,
    memory: '2G',
    mounts: { '/workspace': { hostPath: dir, vmDisk: ['node_modules'] } },
    egress: ['registry.npmjs.org', 'api.example.com'],
  })
  expect(vm.egress).toEqual(['registry.npmjs.org', 'api.example.com'])
  expect(sandbox?.options.mounts?.['/opt/hobwork/cli']).toMatchObject({ readonly: true })
  // Only the CLI is installed: there are no extras.
  expect(sandbox?.commands.map((c) => c.command)).toEqual([expect.stringContaining('/usr/local/bin/hobwork')])

  await vm.stop()
  expect(sandbox?.stopped).toBe(true)
})

test('exec maps cwd into the guest and returns streamed output', async () => {
  const vm = await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  const chunks: string[] = []
  const result = await vm.exec('pnpm test', {
    cwd: 'src/lib',
    timeoutMs: 1000,
    onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`),
  })
  expect(result).toEqual({ exitCode: 0, stdout: 'ran pnpm test\n', stderr: 'warning\n' })
  expect(chunks).toEqual(['stdout:ran pnpm test\n', 'stderr:warning\n'])
  expect(sandboxes[0]?.commands[1]?.options).toMatchObject({ cwd: '/workspace/src/lib', timeoutMs: 1000 })

  await vm.exec('true', { cwd: '.', timeoutMs: 1000 })
  expect(sandboxes[0]?.commands[2]?.options.cwd).toBe('/workspace')
  await expect(vm.exec('true', { cwd: '../etc', timeoutMs: 1000 })).rejects.toThrow('outside')
})

test('installs extras on start', async () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19.3.0', 'left-pad': '1.3.0' } }))
  await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  expect(sandboxes[0]?.commands.slice(1).map((c) => [c.command, c.options.cwd])).toEqual([['pnpm install', '/workspace']])
})

test('platform packages alone are not installed', async () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19.3.0', '@hobwork/sdk': '0.0.0' } }))
  await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  expect(sandboxes[0]?.commands).toHaveLength(1)
})

test('spawned processes keep the VM busy and report signals as exit codes', async () => {
  const vm = await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  const output: string[] = []
  const proc = vm.spawn('bash', {
    cwd: '.',
    env: { TERM: 'xterm' },
    pty: { rows: 24, cols: 80 },
    onData: (stream, data) => output.push(`${stream}:${data}`),
  })
  expect(sandboxes[0]?.commands[1]?.options).toMatchObject({ cwd: '/workspace', env: { TERM: 'xterm' }, pty: { rows: 24, cols: 80 } })
  expect(vm.busy?.()).toBe(true)
  proc.write('echo hi\n')
  proc.end()
  expect(output).toEqual(['stdout:echo hi\n'])
  sandboxes[0]?.exit?.({ exitCode: 0, signal: 15 })
  expect(await proc.result).toEqual({ exitCode: 143 })
  expect(vm.busy?.()).toBe(false)
  expect(() => vm.spawn('true', { cwd: '..', onData: () => {} })).toThrow('outside')
})

test('the internal handler is bound to the workspace', async () => {
  const seen: string[] = []
  await workspaceVmBackend({ image: '/image', createSandbox }, (w) => {
    seen.push(`${w.project}/${w.branch}`)
    return () => new Response('ok')
  })(workspace())
  expect(seen).toEqual(['filament/spools'])
  expect(sandboxes[0]?.options.internal).toBeTypeOf('function')
})

test('workspace VMs get secrets, their hosts, the branch DB and blocked egress logging', async () => {
  const host = createTestHost()
  const data = createProjectData(host)
  try {
    await createProject(host, 'filament')
    const secrets = createSecretStore(host, randomBytes(32))
    const secret = secrets.create({ name: 'Spools', value: 'real', hosts: ['api.spools.example'] }, { kind: 'host' })
    secrets.assign('filament', secret.id, 'API_KEY', { kind: 'host' })
    mkdirSync(join(dir, 'migrations'))
    writeFileSync(join(dir, 'migrations', '0001_spools.sql'), 'CREATE TABLE spools (color TEXT) STRICT;')
    const workspaceEnvironment = createWorkspaceEnvironment(host, { data, secrets })
    const vm = await workspaceVmBackend(
      { image: '/image', createSandbox, workspaceEnvironment },
      () => () => new Response('cli'),
      hasSession,
    )(workspace())
    const options = sandboxes[0]!.options
    expect(options.egress).toEqual(['registry.npmjs.org', 'api.spools.example'])
    expect(options.secrets).toEqual({ API_KEY: { value: 'real', hosts: ['api.spools.example'] } })

    const db = (sql: string) =>
      options.internal!(
        new Request('http://hobwork.internal/v1/db', {
          method: 'POST',
          headers: SESSION,
          body: JSON.stringify({ statements: [{ sql }], transaction: false }),
        }),
      )
    expect((await db("INSERT INTO spools VALUES ('red')")).status).toBe(200)
    expect(await (await db('SELECT color FROM spools')).json()).toMatchObject({ ok: true, results: [{ rows: [{ color: 'red' }] }] })
    const bad = await db('SELECT nope FROM spools')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ ok: false, error: { message: 'no such column: nope', statement: 0 } })
    expect(existsSync(data.branchDbPath('filament', 'spools'))).toBe(true)
    expect(existsSync(data.dbPath('filament'))).toBe(false)
    const cli = await options.internal!(new Request('http://hobwork.internal/v1/workspace/status'))
    expect(await cli.text()).toBe('cli')

    options.onEgressBlocked?.({ hostname: 'tracker.example', ip: '', port: 443 })
    const blocked = queryLogs(host, { project: 'filament', limit: 10 }).find((line) => line.event === 'egress-blocked')
    expect(blocked).toMatchObject({ event: 'egress-blocked', message: expect.stringContaining('Workspace spools: blocked') })

    expect(await vm.isStale?.()).toBe(false)
    secrets.create({ name: 'Other', value: 'o', hosts: ['o.example'], assign: { project: 'filament', envName: 'OTHER' } }, { kind: 'host' })
    expect(await vm.isStale?.()).toBe(true)
    secrets.unassign('filament', 'OTHER', { kind: 'host' })
    expect(await vm.isStale?.()).toBe(false)
    secrets.update(secret.id, { value: 'rotated' }, { kind: 'host' })
    expect(await vm.isStale?.()).toBe(true)
    await vm.stop()
  } finally {
    await data.stop()
    host.dispose()
  }
})

test('workspace VMs refuse DB, Home Assistant and device calls without a valid session', async () => {
  const host = createTestHost()
  try {
    const workspaceEnvironment = createWorkspaceEnvironment(host, { devices: { info: () => [] } as unknown as Devices })
    await workspaceVmBackend({ image: '/image', createSandbox, workspaceEnvironment }, () => () => new Response('cli'), hasSession)(
      workspace(),
    )
    const internal = sandboxes[0]!.options.internal!
    const call = (path: string, headers: Record<string, string>) =>
      internal(new Request(`http://hobwork.internal${path}`, { method: 'POST', headers, body: JSON.stringify({ action: 'list' }) }))
    for (const path of ['/v1/db', '/v1/ha', '/v1/devices']) {
      expect((await call(path, {})).status).toBe(401)
      expect((await call(path, { 'x-hobwork-session': 'forged' })).status).toBe(401)
    }
    expect((await call('/v1/devices', SESSION)).status).toBe(200)

    const noCheck = await workspaceVmBackend({ image: '/image', createSandbox, workspaceEnvironment })(workspace())
    expect((await sandboxes[1]!.options.internal!(new Request('http://hobwork.internal/v1/devices', { method: 'POST', headers: SESSION, body: '{}' }))).status).toBe(401)
    await noCheck.stop()
  } finally {
    host.dispose()
  }
})

test('workspace VMs read Home Assistant states but cannot call services', async () => {
  const host = createTestHost()
  try {
    const calls: string[] = []
    const homeAssistant = {
      configured: true,
      getState: async (entityId: string) => ({ entity_id: entityId, state: 'on', attributes: {} }),
      callService: async (domain: string, service: string) => calls.push(`${domain}.${service}`),
    } as unknown as HomeAssistant
    const workspaceEnvironment = createWorkspaceEnvironment(host, { homeAssistant })
    await workspaceVmBackend(
      { image: '/image', createSandbox, workspaceEnvironment },
      () => () => new Response('cli'),
      hasSession,
    )(workspace())
    const ha = async (request: object) => {
      const res = await sandboxes[0]!.options.internal!(
        new Request('http://hobwork.internal/v1/ha', { method: 'POST', headers: SESSION, body: JSON.stringify(request) }),
      )
      return { status: res.status, body: await res.json() }
    }
    expect(await ha({ action: 'getState', entityId: 'light.kitchen' })).toMatchObject({
      status: 200,
      body: { ok: true, result: { state: 'on' } },
    })
    expect(await ha({ action: 'callService', domain: 'light', service: 'turn_off' })).toMatchObject({
      status: 403,
      body: { ok: false, error: { code: 'read_only' } },
    })
    expect(calls).toEqual([])
  } finally {
    host.dispose()
  }
})

test('workspace VMs list devices but cannot notify them', async () => {
  const host = createTestHost()
  try {
    const sends: unknown[] = []
    const devices = {
      info: () => [{ name: 'kaan-iphone' }],
      sendNotification: async (...args: unknown[]) => sends.push(args),
    } as unknown as Devices
    const workspaceEnvironment = createWorkspaceEnvironment(host, { devices })
    await workspaceVmBackend(
      { image: '/image', createSandbox, workspaceEnvironment },
      () => () => new Response('cli'),
      hasSession,
    )(workspace())
    const call = async (request: object) => {
      const res = await sandboxes[0]!.options.internal!(
        new Request('http://hobwork.internal/v1/devices', { method: 'POST', headers: SESSION, body: JSON.stringify(request) }),
      )
      return { status: res.status, body: await res.json() }
    }
    expect(await call({ action: 'list' })).toEqual({ status: 200, body: { ok: true, result: [{ name: 'kaan-iphone' }] } })
    const send = { action: 'call', device: 'kaan-iphone', capability: 'notifications', method: 'send', args: { title: 'Hi' } }
    expect(await call(send)).toMatchObject({ status: 403, body: { ok: false, error: { code: 'read_only' } } })
    expect(sends).toEqual([])
  } finally {
    host.dispose()
  }
})

test('a workspace VM is stale once the egress allowlist changes', async () => {
  const vm = await workspaceVmBackend({ image: '/image', createSandbox })(workspace())
  expect(await vm.isStale?.()).toBe(false)
  writeFileSync(join(dir, 'hobwork.json'), JSON.stringify({ egress: ['api.example.com'] }))
  expect(await vm.isStale?.()).toBe(true)
  writeFileSync(join(dir, 'hobwork.json'), '{ not json')
  expect(await vm.isStale?.()).toBe(false)
})

test('pipeline VMs only reach the registry and are stopped on shutdown', async () => {
  writeFileSync(join(dir, 'hobwork.json'), JSON.stringify({ egress: ['api.example.com'] }))
  const backend = pipelineVmBackend({ image: '/image', createSandbox })
  const first = await backend.start({ dir })
  await backend.start({ dir })
  expect(sandboxes[0]?.options.egress).toEqual(['registry.npmjs.org'])
  expect(sandboxes[0]?.options.cpus).toBe(4)
  const icons = sandboxes[0]?.options.mounts?.['/opt/hobwork/icons']
  expect(icons).toMatchObject({ readonly: true })
  expect(existsSync(join(icons!.hostPath, 'main.ts'))).toBe(true)
  expect(first.iconsCommand).toBe('node /opt/hobwork/icons/main.ts')

  expect(await first.exec('false', { cwd: '.', timeoutMs: 1000 })).toMatchObject({ exitCode: 1 })
  await first.stop()
  await backend.stopAll()
  expect(sandboxes.map((s) => s.stopped)).toEqual([true, true])
})
