import type { AddressInfo } from 'node:net'
import ssh2, { type ClientChannel } from 'ssh2'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ensureAgent, type Agent } from '../agents.ts'
import { createProject } from '../projects.ts'
import { createBranch } from '../repo.ts'
import { createTestHost } from '../test-host.ts'
import { seedMain } from '../test-project.ts'
import {
  createWorkspaceManager,
  SESSION_ENV,
  type InteractiveWorkspaceVm,
  type SpawnOptions,
  type WorkspaceManager,
} from '../workspaces.ts'
import { createSshGateway, parseTarget } from './gateway.ts'
import { addSshKey, generateEd25519KeyPair } from './keys.ts'

vi.setConfig({ testTimeout: 30_000 })

type Spawned = { command: string; options: SpawnOptions; resizes: [number, number][]; agent?: Agent; killed?: boolean }

let host: ReturnType<typeof createTestHost>
let workspaces: WorkspaceManager<InteractiveWorkspaceVm>
let gateway: ssh2.Server
let port: number
let spawned: Spawned[]
let agent: Agent
let key: { public: string; private: string }

// Stands in for a workspace VM: `exit N`, `echo X` and `whoami` run as commands,
// anything else is a shell that echoes its input until it reads "exit".
function fakeVm(): InteractiveWorkspaceVm {
  return {
    async stop() {},
    async exec() {
      throw new Error('not used')
    },
    spawn(command, options) {
      const record: Spawned = { command, options, resizes: [] }
      const token = options.env?.[SESSION_ENV] ?? ''
      record.agent = workspaces.sessionAgent('filament', 'spools', token)
      spawned.push(record)
      const out = (text: string) => options.onData('stdout', Buffer.from(text))
      let exit: (code: number) => void = () => {}
      const result = new Promise<{ exitCode: number }>((resolve) => {
        exit = (exitCode) => resolve({ exitCode })
      })
      const code = /^exit (\d+)$/.exec(command)
      if (code) exit(Number(code[1]))
      else if (command.startsWith('echo ')) {
        out(`${command.slice(5)}\n`)
        options.onData('stderr', Buffer.from('to stderr\n'))
        exit(0)
      } else if (command === 'whoami') {
        out(`${workspaces.sessionAgent('filament', 'spools', token)?.name}\n`)
        exit(0)
      }
      return {
        result,
        write(data) {
          const text = Buffer.from(data).toString()
          out(`echo: ${text}`)
          if (text.includes('exit')) exit(0)
        },
        end: () => exit(0),
        resize: (rows, cols) => void record.resizes.push([rows, cols]),
        kill: async () => {
          record.killed = true
          exit(137)
        },
      }
    },
  }
}

beforeEach(async () => {
  host = createTestHost()
  spawned = []
  await createProject(host, 'filament')
  await seedMain(host, 'filament')
  await createBranch(host, 'filament', 'spools')
  workspaces = createWorkspaceManager<InteractiveWorkspaceVm>(host, { startVm: async () => fakeVm() })
  agent = ensureAgent(host.db, 'laptop')
  key = generateEd25519KeyPair()
  addSshKey(host.db, agent.id, key.public)
  gateway = createSshGateway({ host, workspaces, hostKey: generateEd25519KeyPair().private })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  port = (gateway.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise((resolve) => gateway.close(resolve))
  await workspaces.stopAll()
  host.dispose()
})

function connect(username: string, auth: Partial<ssh2.ConnectConfig> = { privateKey: key.private }): Promise<ssh2.Client> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    client.on('ready', () => resolve(client)).on('error', reject)
    client.connect({ host: '127.0.0.1', port, username, ...auth })
  })
}

type Outcome = { stdout: string; stderr: string; code: number | undefined }

function collect(channel: ClientChannel): Promise<Outcome> {
  const outcome: Outcome = { stdout: '', stderr: '', code: undefined }
  channel.on('data', (data: Buffer) => (outcome.stdout += data))
  channel.stderr.on('data', (data: Buffer) => (outcome.stderr += data))
  channel.on('exit', (code: number) => (outcome.code = code))
  return new Promise((resolve) => channel.on('close', () => resolve(outcome)))
}

// Output is collected from inside the callback: short-lived commands can exit
// before a promise continuation would attach listeners.
function exec(client: ssh2.Client, command: string): Promise<Outcome> {
  return new Promise((resolve, reject) =>
    client.exec(command, (err, channel) => (err ? reject(err) : resolve(collect(channel)))),
  )
}

async function run(username: string, command: string): Promise<Outcome> {
  const client = await connect(username)
  try {
    return await exec(client, command)
  } finally {
    client.end()
  }
}

describe('parseTarget', () => {
  test('splits at the first slash or plus', () => {
    expect(parseTarget('filament/spools')).toEqual({ project: 'filament', branch: 'spools' })
    expect(parseTarget('filament/feature/spools')).toEqual({ project: 'filament', branch: 'feature/spools' })
    expect(parseTarget('filament+feature/spools')).toEqual({ project: 'filament', branch: 'feature/spools' })
  })

  test('rejects anything else', () => {
    expect(() => parseTarget('filament')).toThrow('<project>/<branch>')
    expect(() => parseTarget('Filament/spools')).toThrow('Invalid project name')
    expect(() => parseTarget('filament/../x')).toThrow('Invalid branch name')
    expect(() => parseTarget('/spools')).toThrow('<project>/<branch>')
  })
})

test('a registered key runs a command in the branch workspace with its exit status', async () => {
  const echo = await run('filament/spools', 'echo hi there')
  expect(echo).toEqual({ stdout: 'hi there\n', stderr: 'to stderr\n', code: 0 })
  expect(spawned[0]).toMatchObject({ command: 'echo hi there', options: { cwd: '.' } })
  expect(spawned[0]?.options.pty).toBeUndefined()
  expect(workspaces.get('filament', 'spools')?.status).toBe('running')

  expect((await run('filament+spools', 'exit 3')).code).toBe(3)
})

test('commands run with a session for the key\'s agent, closed when they end', async () => {
  expect((await run('filament/spools', 'whoami')).stdout).toBe('laptop\n')
  const token = spawned[0]?.options.env?.[SESSION_ENV] ?? ''
  expect(spawned[0]?.agent).toEqual(agent)
  expect(workspaces.sessionAgent('filament', 'spools', token)).toBeUndefined()
})

test('unknown keys and passwords are rejected', async () => {
  const other = generateEd25519KeyPair()
  await expect(connect('filament/spools', { privateKey: other.private })).rejects.toThrow('authentication methods failed')
  await expect(connect('filament/spools', { password: 'hunter2' })).rejects.toThrow('authentication methods failed')
  expect(spawned).toEqual([])
})

test('main, bad user names and missing branches are refused with a message', async () => {
  const main = await run('filament/main', 'echo hi')
  expect(main.code).toBe(1)
  expect(main.stderr).toContain('main is the deployed version')
  const bad = await run('filament', 'echo hi')
  expect(bad.code).toBe(1)
  expect(bad.stderr).toContain('Connect as <project>/<branch>')
  const missing = await run('filament/nope', 'echo hi')
  expect(missing.code).toBe(1)
  expect(missing.stderr).toContain('Branch "nope" does not exist in filament')
  const project = await run('nope/spools', 'echo hi')
  expect(project.code).toBe(1)
  expect(project.stderr).toContain('nope')
  expect(spawned).toEqual([])
})

test('an interactive shell gets a PTY, follows window changes and ends with the shell', async () => {
  const client = await connect('filament/spools')
  try {
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      client.shell({ rows: 30, cols: 100, term: 'xterm-kitty' }, (err, ch) => (err ? reject(err) : resolve(ch))),
    )
    const outcome = collect(channel)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    expect(spawned[0]).toMatchObject({
      command: 'exec bash --login',
      options: { pty: { rows: 30, cols: 100 }, env: { TERM: 'xterm-kitty' } },
    })
    channel.setWindow(40, 120, 0, 0)
    await vi.waitFor(() => expect(spawned[0]?.resizes).toEqual([[40, 120]]))
    channel.write('ls\n')
    await vi.waitFor(() => expect(spawned[0]?.agent).toEqual(agent))
    channel.write('exit\n')
    const { stdout, stderr, code } = await outcome
    expect(stdout).toBe('echo: ls\necho: exit\n')
    expect(stderr).toContain('Starting the workspace for filament/spools...\r\n')
    expect(stderr).toContain('Workspace filament/spools as laptop.')
    expect(code).toBe(0)
  } finally {
    client.end()
  }
})

test('closing the connection kills the command', async () => {
  const client = await connect('filament/spools')
  void exec(client, 'cat')
  await vi.waitFor(() => expect(spawned).toHaveLength(1))
  client.end()
  await vi.waitFor(() => expect(spawned[0]?.killed).toBe(true))
})
