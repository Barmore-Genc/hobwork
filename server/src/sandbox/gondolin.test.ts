import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createGondolinSandbox } from './gondolin.ts'
import { imageDir, imageExists } from './image.ts'
import type { OutputChunk, Sandbox, SandboxOptions } from './sandbox.ts'
import { systemEnv } from './system-env.ts'

// Boots real VMs, so it only runs with HOBWORK_VM_TESTS=1 (`pnpm test:vm`).
describe.runIf(process.env.HOBWORK_VM_TESTS === '1')('gondolin sandbox', { timeout: 60_000 }, () => {
  const image = imageDir()
  const dirs: string[] = []
  const started: Sandbox[] = []
  const internalRequests: { method: string, path: string, auth: string | null, body: string }[] = []
  const blocked: string[] = []
  let sandbox: Sandbox
  let work: string
  let config: string

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hobwork-sandbox-test-'))
    dirs.push(dir)
    return dir
  }

  async function start(options: Omit<SandboxOptions, 'image'>): Promise<Sandbox> {
    const s = await createGondolinSandbox({ image, memory: '512M', ...options })
    started.push(s)
    return s
  }

  beforeAll(async () => {
    if (!imageExists(image)) throw new Error(`no guest image at ${image}, run images/build.sh`)
    work = tempDir()
    config = tempDir()
    writeFileSync(join(config, 'settings.json'), '{"a":1}')
    writeFileSync(join(work, '.env'), 'TOKEN=real')
    sandbox = await start({
      mounts: {
        '/workspace': { hostPath: work, hide: ['.env'] },
        '/config': { hostPath: config, readonly: true },
      },
      env: { GREETING: 'hello' },
      egress: ['allowed.example'],
      secrets: { API_KEY: { value: 'super-secret-value', hosts: ['api.example'] } },
      internal: async (request) => {
        const url = new URL(request.url)
        internalRequests.push({
          method: request.method,
          path: url.pathname,
          auth: request.headers.get('authorization'),
          body: await request.text(),
        })
        return Response.json({ from: 'host', path: url.pathname })
      },
      onEgressBlocked: (event) => blocked.push(event.hostname),
    })
  }, 120_000)

  afterAll(async () => {
    await Promise.all(started.map((s) => s.stop()))
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  test('runs a command in a mounted directory with streamed output', async () => {
    const chunks: OutputChunk[] = []
    const proc = sandbox.exec('echo "$GREETING" > out.txt; cat out.txt; echo oops >&2; exit 3', {
      cwd: '/workspace',
      onOutput: (chunk) => chunks.push(chunk),
    })
    const result = await proc.result
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, killed: false, stdout: '' })
    expect(chunks).toContainEqual({ stream: 'stdout', text: 'hello\n' })
    expect(chunks).toContainEqual({ stream: 'stderr', text: 'oops\n' })
    expect(readFileSync(join(work, 'out.txt'), 'utf8')).toBe('hello\n')
  })

  test('has the host time zone and locale', async () => {
    const script = [
      'const zone = Intl.DateTimeFormat().resolvedOptions().timeZone',
      'const offset = new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()',
      'const german = new Date(Date.UTC(2026, 0, 1)).toLocaleDateString("de-DE", { month: "long", timeZone: "UTC" })',
      'console.log(JSON.stringify({ zone, offset, german, lang: process.env.LANG ?? null }))',
    ].join(';')
    const result = await sandbox.exec(`node -e '${script}'; TZ=Europe/Istanbul date +%Z`).result
    const [node, shell] = result.stdout.trim().split('\n')
    expect(JSON.parse(node ?? '')).toEqual({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset(),
      german: 'Januar',
      lang: systemEnv().LANG ?? null,
    })
    expect(shell).toBe('+03')
  })

  test('buffers output when no callback is given', async () => {
    const result = await sandbox.exec('echo "$A-$B"; pwd', { env: { A: '1', B: '2' }, cwd: '/tmp' }).result
    expect(result.stdout).toBe('1-2\n/tmp\n')
    expect(result.exitCode).toBe(0)
  })

  test('has the platform toolchain and dependency set', async () => {
    const result = await sandbox.exec(
      'node --version && pnpm --version && git --version && tsc --version && vitest --version && oxlint --version'
      + ' && node -e "import(\'react\').then((m) => console.log(\'react\', m.version))"',
      { cwd: '/workspace' },
    ).result
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^v\d+/)
    expect(result.stdout).toContain('react 19.')
  })

  test('readonly mounts reject writes and hidden paths are invisible', async () => {
    const result = await sandbox.exec(
      'cat /config/settings.json; echo; touch /config/x && echo wrote; ls -a /workspace; cat /workspace/.env || echo hidden',
    ).result
    expect(result.stdout).toContain('{"a":1}')
    expect(result.stdout).not.toContain('wrote')
    expect(result.stdout).not.toContain('.env')
    expect(result.stdout).toContain('hidden')
  })

  test('reads and writes guest files', async () => {
    await sandbox.writeFile('/tmp/from-host.txt', 'host data')
    const result = await sandbox.exec('cat /tmp/from-host.txt; echo guest data > /tmp/from-guest.txt').result
    expect(result.stdout).toBe('host data')
    expect((await sandbox.readFile('/tmp/from-guest.txt')).toString()).toBe('guest data\n')
  })

  test('runs commands concurrently', async () => {
    const slow = sandbox.exec('sleep 2; echo slow')
    const t0 = performance.now()
    const fast = await sandbox.exec('echo fast').result
    expect(fast.stdout).toBe('fast\n')
    expect(performance.now() - t0).toBeLessThan(1500)
    expect((await slow.result).stdout).toBe('slow\n')
  })

  test('a timeout kills the whole process tree', async () => {
    const result = await sandbox.exec('sleep 300 & sleep 301; echo done', { timeoutMs: 500 }).result
    expect(result.timedOut).toBe(true)
    expect(result.stdout).not.toContain('done')
    const ps = await sandbox.exec('ps -o args').result
    expect(ps.stdout).not.toMatch(/sleep 30[01]/)
  })

  test('kill ends processes that ignore SIGTERM', async () => {
    const proc = sandbox.exec('trap "" TERM; sleep 302')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await proc.kill()
    const result = await proc.result
    expect(result.killed).toBe(true)
    expect(result.signal).toBe(9)
  })

  test('an abort signal kills the process', async () => {
    const controller = new AbortController()
    const proc = sandbox.exec('sleep 303', { signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const result = await proc.result
    expect(result.killed).toBe(true)
  })

  test('ingress reaches a server in the guest', async () => {
    const server = sandbox.exec(
      'node -e "require(\'http\').createServer((q, s) => s.end(\'hi from \' + q.url)).listen(8000, \'127.0.0.1\')"',
    )
    const url = await sandbox.ingress(8000)
    let body = ''
    for (let i = 0; i < 50 && !body.startsWith('hi'); i++) {
      body = await fetch(`${url}/ping`).then((r) => r.text(), () => '')
      if (!body.startsWith('hi')) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(body).toBe('hi from /ping')
    await server.kill()
  })

  test('ingress waits for a guest server that answers slowly', async () => {
    const server = sandbox.exec(
      'node -e "require(\'http\').createServer((q, s) => setTimeout(() => s.end(\'slow\'), 3000)).listen(8001, \'127.0.0.1\')"',
    )
    const url = await sandbox.ingress(8001)
    let res: Response | undefined
    for (let i = 0; i < 50 && !res; i++) {
      res = await fetch(`${url}/`).catch(() => undefined)
      if (res?.status === 502 && i < 49) {
        res = undefined
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    expect(res?.status).toBe(200)
    expect(await res?.text()).toBe('slow')
    await server.kill()
  })

  test('the internal host is answered by the host handler', async () => {
    internalRequests.length = 0
    const curl = await sandbox.exec(
      'curl -sS -X POST -d ping -H "Authorization: Bearer $API_KEY" http://hobwork.internal/v1/echo',
    ).result
    expect(JSON.parse(curl.stdout)).toEqual({ from: 'host', path: '/v1/echo' })
    const node = await sandbox.exec(
      'node -e "fetch(\'https://hobwork.internal/v1/tls\').then((r) => r.json()).then((j) => console.log(j.path))"',
    ).result
    expect(node.stdout).toBe('/v1/tls\n')
    expect(internalRequests[0]).toMatchObject({ method: 'POST', path: '/v1/echo', body: 'ping' })
    // The secret is not bound to the internal host, so the handler only sees the placeholder.
    expect(internalRequests[0]?.auth).not.toContain('super-secret-value')
    expect(internalRequests[0]?.auth).toMatch(/^Bearer GONDOLIN_SECRET_/)
  })

  test('egress outside the allowlist is blocked', async () => {
    blocked.length = 0
    const result = await sandbox.exec('curl -s -o /dev/null -w "%{http_code}" http://example.com/').result
    expect(result.stdout).toBe('403')
    expect(blocked).toContain('example.com')
  })

  test('egress to a host that does not resolve is blocked and reported too', async () => {
    blocked.length = 0
    const result = await sandbox.exec('curl -s -o /dev/null -w "%{http_code}" https://nothing-here.invalid/').result
    expect(result.stdout).toBe('403')
    expect(blocked).toEqual(['nothing-here.invalid'])
  })

  test('host services are not reachable from the guest', async () => {
    const server = createServer((_req, res) => res.end('host service'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const result = await sandbox.exec(
        `for h in 127.0.0.1 10.0.2.2 host.docker.internal localhost; do curl -s -m 5 http://$h:${port}/; echo " $h"; done`,
      ).result
      expect(result.stdout).not.toContain('host service')
    } finally {
      server.close()
    }
  })

  test('secrets are placeholders in the guest', async () => {
    const result = await sandbox.exec('echo "$API_KEY"').result
    expect(result.stdout).toMatch(/^GONDOLIN_SECRET_/)
    expect(result.stdout).not.toContain('super-secret-value')
  })

  test('secrets are refused in other headers and over http', async () => {
    const guarded = await start({
      egress: ['api.example'],
      secrets: { API_KEY: { value: 'super-secret-value', hosts: ['api.example'], headers: ['x-api-key'] } },
    })
    const other = await guarded.exec('curl -s -m 20 -H "X-Other: $API_KEY" https://api.example/').result
    expect(other.stdout).toContain('hobwork_secret_not_allowed')
    expect(other.stdout).toContain('Found it in the x-other header')
    const plain = await guarded.exec('curl -s -m 20 -H "Authorization: Bearer $API_KEY" http://api.example/').result
    expect(plain.stdout).toContain('Hobwork only sends API_KEY over https')
    await guarded.stop()
  })

  test('internal handlers take streamed bodies over 64MB when they opt in, and stream answers', { timeout: 180_000 }, async () => {
    const size = 80 * 1024 * 1024
    const received: { path: string, bytes: number }[] = []
    const streaming = await start({
      streamInternal: (request) => new URL(request.url).pathname.startsWith('/upload/'),
      internal: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/download') {
          let sent = 0
          return new Response(new ReadableStream({
            pull(controller) {
              if (sent >= size) return controller.close()
              sent += 1024 * 1024
              controller.enqueue(new Uint8Array(1024 * 1024))
            },
          }))
        }
        let bytes = 0
        for await (const chunk of request.body ?? []) bytes += chunk.length
        received.push({ path: url.pathname, bytes })
        return new Response(String(bytes))
      },
    })
    const run = async (command: string) => (await streaming.exec(command).result).stdout
    await run(`head -c ${size} /dev/zero > /tmp/big`)
    expect(await run('curl -sS --data-binary @/tmp/big http://hobwork.internal/upload/length')).toBe(String(size))
    expect(await run('curl -sS -X POST -T - http://hobwork.internal/upload/chunked < /tmp/big')).toBe(String(size))
    expect(await run('curl -sS -o /dev/null -w "%{size_download}" http://hobwork.internal/download')).toBe(String(size))
    expect(await run('curl -sS -o /dev/null -w "%{http_code}" --data-binary @/tmp/big http://hobwork.internal/other')).toBe('413')
    expect(received).toEqual([
      { path: '/upload/length', bytes: size },
      { path: '/upload/chunked', bytes: size },
    ])
    await streaming.stop()
  })

  test('each sandbox gets its own internal handler', async () => {
    const other = await start({ internal: () => new Response('other') })
    const result = await other.exec('curl -sS http://hobwork.internal/').result
    expect(result.stdout).toBe('other')
    await other.stop()
  })

  // Node's HTTP agent turns on TCP keepalive with 1s probes, so a guest
  // connection that gets no ACK for them times out after about 11s.
  test('a slow internal answer survives TCP keepalive probes', { timeout: 90_000 }, async () => {
    const slow = await start({
      internal: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25_000))
        return new Response('late')
      },
    })
    const result = await slow.exec(
      `node -e "require('node:http').get('http://hobwork.internal/', (r) => r.pipe(process.stdout)).on('error', (e) => console.log(e.message))"`,
    ).result
    expect(result.stdout).toBe('late')
  })

  test('extra dependencies install onto the VM disk on top of the platform set', async () => {
    const project = tempDir()
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      type: 'module',
      dependencies: { 'react-markdown': '10.1.0' },
    }))
    // Without this pnpm installs its own React for the peer dependency, and the project gets two.
    writeFileSync(join(project, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n')
    const s = await start({
      memory: '1G',
      mounts: { '/workspace': { hostPath: project, vmDisk: ['node_modules'] } },
      egress: ['registry.npmjs.org'],
    })
    const install = await s.exec('pnpm install', { cwd: '/workspace' }).result
    expect(install.exitCode, install.stdout + install.stderr).toBe(0)
    const render = await s.exec(
      'node --input-type=module -e "'
      + 'import Markdown from \'react-markdown\'; import { createElement } from \'react\'; '
      + 'import { renderToString } from \'react-dom/server\'; '
      + 'console.log(renderToString(createElement(Markdown, null, \'# hi\')))"; '
      + 'ls node_modules/.pnpm | grep -c "^react@" || true; mount | grep -c /workspace/node_modules',
      { cwd: '/workspace' },
    ).result
    expect(render.stdout).toBe('<h1>hi</h1>\n0\n1\n')
    expect(existsSync(join(project, 'node_modules'))).toBe(false)
    expect(existsSync(join(project, 'pnpm-lock.yaml'))).toBe(true)
    await s.stop()
  })

  test('stop shuts the VM down', async () => {
    const s = await start({})
    expect(s.hostPid()).toBeTypeOf('number')
    await s.stop()
    expect(s.hostPid()).toBeNull()
    await s.exited
  })

  test('exited resolves when the VM process dies without stop', async () => {
    const s = await start({})
    process.kill(s.hostPid()!, 'SIGKILL')
    await s.exited
    await s.stop()
  })
})
