import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ExecResult, Sandbox, SandboxFactory, SandboxOptions } from '../sandbox/sandbox.ts'

// TEST ONLY. Stands in for a runtime VM: runs the real runner as a host
// process against the mounted build, and serves the internal endpoint on a
// local port. No sandboxing at all.
export type FakeRuntimeSandboxes = {
  factory: SandboxFactory
  created: SandboxOptions[]
  running: Set<FakeSandbox>
  // Makes the next sandbox fail to boot.
  failNextCreate(): void
}

type FakeSandbox = Sandbox & { options: SandboxOptions; crash(): void }

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

function mountPath(options: SandboxOptions, guestPath: string): string {
  const mount = options.mounts?.[guestPath]
  if (!mount) throw new Error(`fake sandbox: nothing mounted at ${guestPath}`)
  return mount.hostPath
}

export function fakeRuntimeSandboxes(): FakeRuntimeSandboxes {
  const created: SandboxOptions[] = []
  const running = new Set<FakeSandbox>()
  let failNext = false

  const factory: SandboxFactory = async (options) => {
    created.push(options)
    if (failNext) {
      failNext = false
      throw new Error('fake sandbox: boot failed')
    }
    const internal = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', async () => {
        const request = new Request(`http://hobwork.internal${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
        })
        const response = await options.internal!(request)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    })
    const internalUrl = `http://127.0.0.1:${await listen(internal)}`
    const ports = new Map<number, number>()
    const children = new Set<ChildProcess>()

    const sandbox: FakeSandbox = {
      id: randomUUID(),
      options,
      spawn() {
        throw new Error('fake sandbox does not run interactive processes')
      },
      exec(command, execOptions = {}) {
        const match = /^node (\/\S+)\/main\.ts$/.exec(command)
        if (!match) throw new Error(`fake sandbox only runs the runner, got: ${command}`)
        const guestPort = Number(execOptions.env?.HOBWORK_RUNNER_PORT)
        const result = (async (): Promise<ExecResult> => {
          const port = await freePort()
          ports.set(guestPort, port)
          const child = spawn(process.execPath, [join(mountPath(options, match[1]!), 'main.ts')], {
            env: {
              ...process.env,
              ...execOptions.env,
              HOBWORK_APP_DIR: mountPath(options, execOptions.env?.HOBWORK_APP_DIR ?? '/app'),
              HOBWORK_INTERNAL_URL: internalUrl,
              HOBWORK_RUNNER_PORT: String(port),
            },
          })
          children.add(child)
          child.stdout?.on('data', (chunk: Buffer) => execOptions.onOutput?.({ stream: 'stdout', text: chunk.toString() }))
          child.stderr?.on('data', (chunk: Buffer) => execOptions.onOutput?.({ stream: 'stderr', text: chunk.toString() }))
          return new Promise((resolve) =>
            child.on('close', (code, signal) => {
              children.delete(child)
              resolve({
                exitCode: code ?? 128,
                signal: signal ? 9 : undefined,
                timedOut: false,
                killed: false,
                stdout: '',
                stderr: '',
              })
            }),
          )
        })()
        return {
          result,
          async kill() {
            for (const child of children) child.kill('SIGKILL')
          },
        }
      },
      async ingress(port) {
        for (let i = 0; i < 100 && !ports.has(port); i++) await new Promise((r) => setTimeout(r, 10))
        return `http://127.0.0.1:${ports.get(port)}`
      },
      async readFile() {
        throw new Error('not supported')
      },
      async writeFile() {
        throw new Error('not supported')
      },
      hostPid: () => null,
      async stop() {
        running.delete(sandbox)
        for (const child of children) child.kill('SIGKILL')
        internal.closeAllConnections()
        await new Promise((resolve) => internal.close(resolve))
      },
      crash() {
        for (const child of children) child.kill('SIGKILL')
      },
    }
    running.add(sandbox)
    return sandbox
  }

  return {
    factory,
    created,
    running,
    failNextCreate() {
      failNext = true
    },
  }
}
