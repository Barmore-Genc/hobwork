import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ssh2, { type ServerChannel, type Session } from 'ssh2'
import type { Agent } from '../agents.ts'
import type { Host } from '../host.ts'
import { DEFAULT_BRANCH, ProjectError, validateProjectName } from '../projects.ts'
import { validateBranchName } from '../repo.ts'
import type { InteractiveWorkspaceVm, WorkspaceManager, WorkspaceProcess } from '../workspaces.ts'
import { findSshKey, generateEd25519KeyPair, markSshKeyUsed } from './keys.ts'

const HOST_KEY_FILE = 'ssh_host_ed25519_key'
const SHELL = 'exec bash --login'
const DEFAULT_TERM = 'xterm-256color'

export type SshTarget = { project: string; branch: string }

// `<project>/<branch>`, or `<project>+<branch>` for clients that do not accept a
// slash in the user name. Project names contain neither, so the first one splits.
export function parseTarget(username: string): SshTarget {
  const match = /^([^/+]+)[/+](.+)$/.exec(username)
  if (!match) {
    throw new ProjectError(`Connect as <project>/<branch>, e.g. ssh filament/add-spools@<host>. Got "${username}"`)
  }
  const [, project = '', branch = ''] = match
  validateProjectName(project)
  validateBranchName(branch)
  return { project, branch }
}

export function loadHostKey(dataDir: string): Buffer {
  const path = join(dataDir, HOST_KEY_FILE)
  if (!existsSync(path)) {
    const { private: key } = generateEd25519KeyPair()
    writeFileSync(path, key, { mode: 0o600, flag: 'wx' })
  }
  return readFileSync(path)
}

export type SshGatewayOptions = {
  host: Host
  workspaces: WorkspaceManager<InteractiveWorkspaceVm>
  hostKey: Buffer | string
}

export function createSshGateway({ host, workspaces, hostKey }: SshGatewayOptions): ssh2.Server {
  return new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    let agent: Agent | undefined
    let username = ''

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      const found = findSshKey(host.db, ctx.key.data)
      if (!found) return ctx.reject(['publickey'])
      // Without a signature the client only asks whether the key would be accepted.
      if (ctx.signature) {
        if (!ctx.blob || found.key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
          return ctx.reject(['publickey'])
        }
        markSshKeyUsed(host.db, found.id)
        agent = found.agent
        username = ctx.username
      }
      ctx.accept()
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        if (agent) handleSession(accept(), agent, username)
      })
    })

    // Connection resets and protocol errors end only this client.
    client.on('error', () => {})
  })

  function handleSession(session: Session, agent: Agent, username: string): void {
    let pty: { rows: number; cols: number; term: string } | undefined
    let proc: WorkspaceProcess | undefined

    session.on('pty', (accept, _reject, info) => {
      pty = { rows: info.rows, cols: info.cols, term: info.term }
      accept?.()
    })
    session.on('window-change', (accept, _reject, info) => {
      if (pty) Object.assign(pty, { rows: info.rows, cols: info.cols })
      proc?.resize(info.rows, info.cols)
      accept?.()
    })
    session.on('env', (_accept, reject) => reject?.())
    session.on('shell', (accept) => {
      void run(accept(), undefined)
    })
    session.on('exec', (accept, _reject, info) => {
      void run(accept(), info.command)
    })
    session.on('subsystem', (_accept, reject) => reject())

    async function run(channel: ServerChannel, command: string | undefined): Promise<void> {
      const newline = pty ? '\r\n' : '\n'
      const message = (text: string) => channel.stderr.write(`${text.replaceAll('\n', newline)}${newline}`)
      const fail = (text: string) => {
        message(text)
        channel.exit(1)
        channel.end()
      }
      let closed = false
      let exited = false
      channel.on('close', () => {
        closed = true
        if (proc && !exited) {
          proc.kill().catch((err: unknown) => console.error('SSH: killing a command after disconnect failed', err))
        }
      })

      let target: SshTarget
      try {
        target = parseTarget(username)
      } catch (err) {
        return fail((err as Error).message)
      }
      const { project, branch } = target
      if (branch === DEFAULT_BRANCH) {
        return fail(
          `${DEFAULT_BRANCH} is the deployed version and changes only by merging a branch. Connect to a branch instead: ssh ${project}/<branch>@<host>`,
        )
      }
      if (!workspaces.canStartVms) {
        return fail('This Hobwork host cannot run commands: no workspace VM backend is configured')
      }

      let vm: InteractiveWorkspaceVm
      try {
        if (command === undefined && workspaces.get(project, branch)?.status !== 'running') {
          message(`Starting the workspace for ${project}/${branch}...`)
        }
        vm = await workspaces.start(project, branch)
      } catch (err) {
        if (!(err instanceof ProjectError)) console.error(`SSH: starting workspace ${project}/${branch} failed`, err)
        return fail(err instanceof ProjectError ? err.message : `Could not start the workspace: ${(err as Error).message}`)
      }
      if (closed) return

      workspaces.touch(project, branch)
      const workspaceSession = workspaces.openSession(project, branch, agent)
      if (command === undefined && pty) {
        message(`Workspace ${project}/${branch} as ${agent.name}. Run hobwork for status, commit and merge.`)
      }
      try {
        proc = vm.spawn(command ?? SHELL, {
          cwd: '.',
          env: { ...workspaceSession.env, ...(pty ? { TERM: pty.term || DEFAULT_TERM } : {}) },
          pty: pty && { rows: pty.rows, cols: pty.cols },
          onData: (stream, data) => {
            if (!closed) (stream === 'stderr' ? channel.stderr : channel).write(data)
          },
        })
        const running = proc
        // Input that arrives after the process exited is dropped.
        channel.on('data', (data: Buffer) => {
          try {
            running.write(data)
          } catch {}
        })
        channel.on('end', () => {
          try {
            running.end()
          } catch {}
        })
        const { exitCode } = await running.result
        exited = true
        if (!closed) {
          channel.exit(exitCode)
          channel.end()
        }
      } catch (err) {
        exited = true
        console.error(`SSH: command in workspace ${project}/${branch} failed`, err)
        if (!closed) fail(`The command could not run: ${(err as Error).message}`)
      } finally {
        workspaceSession.close()
        workspaces.touch(project, branch)
      }
    }
  }
}
