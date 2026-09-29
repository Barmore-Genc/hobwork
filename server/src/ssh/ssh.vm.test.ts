import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import ssh2 from 'ssh2'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ensureAgent } from '../agents.ts'
import { createDelivery } from '../delivery.ts'
import { pipelineVmBackend, workspaceVmBackend, type GuestVmOptions } from '../guest-vm.ts'
import { createProject } from '../projects.ts'
import { createBranch } from '../repo.ts'
import { createGondolinSandbox } from '../sandbox/gondolin.ts'
import { imageDir, imageExists } from '../sandbox/image.ts'
import { createTestHost } from '../test-host.ts'
import { createWorkspaceApi } from '../workspace-api.ts'
import { createWorkspaceManager, type InteractiveWorkspaceVm } from '../workspaces.ts'
import { createSshGateway } from './gateway.ts'
import { addSshKey } from './keys.ts'

type SshRun = { stdout: string; stderr: string; code: number }

// Boots real VMs and uses the system OpenSSH client, so it only runs with
// HOBWORK_VM_TESTS=1 (`pnpm test:vm`). Nothing touches ~/.ssh.
describe.runIf(process.env.HOBWORK_VM_TESTS === '1')('SSH gateway with real VMs', { timeout: 300_000 }, () => {
  const vmOptions: GuestVmOptions = { image: imageDir(), createSandbox: createGondolinSandbox }
  const pipelineVms = pipelineVmBackend(vmOptions)
  let host: ReturnType<typeof createTestHost>
  let workspaces: ReturnType<typeof createWorkspaceManager<InteractiveWorkspaceVm>>
  let gateway: ssh2.Server
  let port: number
  let dir: string

  beforeAll(async () => {
    if (!imageExists(vmOptions.image)) throw new Error(`no guest image at ${vmOptions.image}, run images/build.sh`)
    host = createTestHost()
    workspaces = createWorkspaceManager<InteractiveWorkspaceVm>(host, {
      startVm: workspaceVmBackend(vmOptions, (workspace) => api(workspace)),
    })
    const delivery = createDelivery(host, { workspaces, pipeline: { startVm: pipelineVms.start } })
    const api = createWorkspaceApi({ host, workspaces, delivery })
    await createProject(host, 'filament')
    await createBranch(host, 'filament', 'greeting')

    dir = mkdtempSync(join(tmpdir(), 'hobwork-ssh-vm-test-'))
    await new Promise<void>((resolve, reject) =>
      execFile('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')], (err) =>
        err ? reject(err) : resolve(),
      ),
    )
    addSshKey(host.db, ensureAgent(host.db, 'laptop').id, readFileSync(join(dir, 'key.pub'), 'utf8'))
    gateway = createSshGateway({ host, workspaces, hostKey: ssh2.utils.generateKeyPairSync('ed25519').private })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    port = (gateway.address() as AddressInfo).port
  })

  afterAll(async () => {
    if (gateway) await new Promise((resolve) => gateway.close(resolve))
    await workspaces?.stopAll()
    await pipelineVms.stopAll()
    host?.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function sshArgs(user: string): string[] {
    return [
      '-F', '/dev/null',
      '-i', join(dir, 'key'),
      '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none',
      '-o', 'BatchMode=yes',
      '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'LogLevel=ERROR',
      '-p', String(port),
      `${user}@127.0.0.1`,
    ]
  }

  function ssh(user: string, args: string[], input?: string): Promise<SshRun> {
    return new Promise((resolve) => {
      const child = spawn('/usr/bin/ssh', [...sshArgs(user), ...args], {
        env: { PATH: process.env.PATH, TERM: 'xterm-256color' },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
      child.stdin.end(input)
    })
  }

  const user = 'filament/greeting'

  test('ssh runs pnpm test in the workspace and passes exit statuses through', async () => {
    const tests = await ssh(user, ['pnpm test'])
    expect(tests.code, tests.stdout + tests.stderr).toBe(0)
    expect(stripVTControlCharacters(tests.stdout)).toMatch(/Tests\s+\d+ passed/)
    expect((await ssh('filament+greeting', ['exit 7'])).code).toBe(7)
    const main = await ssh('filament/main', ['true'])
    expect(main.code).toBe(1)
    expect(main.stderr).toContain('main is the deployed version')
  })

  test('an interactive shell gets a terminal in /workspace', async () => {
    const shell = await ssh(user, ['-tt'], 'echo "term=$TERM"; tty; pwd; exit 0\n')
    expect(shell.code, shell.stdout + shell.stderr).toBe(0)
    expect(shell.stdout).toContain('term=xterm-256color')
    expect(shell.stdout).toMatch(/\/dev\/pts\/\d+/)
    expect(shell.stdout).toContain('/workspace')
  })

  test('hobwork status, commit and merge work inside the VM', async () => {
    const status = await ssh(user, ['hobwork status'])
    expect(status.code, status.stderr).toBe(0)
    expect(status.stdout).toContain('Workspace filament/greeting, working as laptop')

    const change = await ssh(user, [
      'echo "export const extra = 1" > src/extra.ts && hobwork status && hobwork commit "Add extra"',
    ])
    expect(change.code, change.stderr).toBe(0)
    expect(change.stdout).toContain('?? src/extra.ts')
    expect(change.stdout).toMatch(/Committed [0-9a-f]{40}/)

    const merge = await ssh(user, ['hobwork merge "Add extra"'])
    expect(merge.code, merge.stdout + merge.stderr).toBe(0)
    expect(merge.stdout).toMatch(/^Merged greeting into main as version 2/)
  })
})
