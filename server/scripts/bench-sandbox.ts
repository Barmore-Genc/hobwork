// Sandbox benchmarks: VM boot, exec latency, memory, parallel VMs, HTTPS egress,
// and tsc/vitest on a small project with different workspace layouts.
//
// Usage: node scripts/bench-sandbox.ts [vm|vfs ...]   (default: both)
// Env: HOBWORK_IMAGE_DIR, BENCH_PARALLEL (default 8), BENCH_EGRESS_URL.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { createGondolinSandbox } from '../src/sandbox/gondolin.ts'
import { imageDir, imageExists } from '../src/sandbox/image.ts'
import { writeProject } from './bench-project.ts'
import type { Sandbox, SandboxOptions } from '../src/sandbox/sandbox.ts'

const image = imageDir()
if (!imageExists(image)) {
  console.error(`no guest image at ${image}, run images/build.sh`)
  process.exit(1)
}
const sections = process.argv.slice(2)
const run = (name: string) => sections.length === 0 || sections.includes(name)
const parallel = Number(process.env.BENCH_PARALLEL ?? 8)
const egressUrl = new URL(process.env.BENCH_EGRESS_URL ?? 'https://example.com/')

function start(options: Omit<SandboxOptions, 'image'> = {}): Promise<Sandbox> {
  return createGondolinSandbox({ image, memory: '512M', cpus: 2, ...options })
}

async function sh(sandbox: Sandbox, command: string, cwd?: string): Promise<string> {
  const result = await sandbox.exec(command, { cwd }).result
  if (result.exitCode !== 0) throw new Error(`${command} failed (${result.exitCode}):\n${result.stdout}${result.stderr}`)
  return result.stdout
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN
  return `median ${at(0.5).toFixed(0)}ms, min ${at(0).toFixed(0)}ms, max ${at(1).toFixed(0)}ms (n=${samples.length})`
}

function rssMb(pid: number | null): number {
  if (pid === null) return NaN
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
}

function report(label: string, value: string) {
  console.log(`${label.padEnd(40)} ${value}`)
}

console.log(`host: ${platform()} ${arch()}, ${cpus().length} CPUs, ${(totalmem() / 2 ** 30).toFixed(0)}GB, node ${process.version}`)
console.log(`image: ${image}\nVMs: 512M, 2 vCPUs\n`)

if (run('vm')) {
  const boots: number[] = []
  for (let i = 0; i < 5; i++) {
    let sandbox: Sandbox | undefined
    boots.push(await time(async () => {
      sandbox = await start()
      await sh(sandbox, 'true')
    }))
    await sandbox?.stop()
  }
  report('create to first command', stats(boots))

  const sandbox = await start({ egress: [egressUrl.hostname] })
  const pid = sandbox.hostPid()
  report('host RSS, fresh VM', `${rssMb(pid).toFixed(0)}MB`)

  const execs: number[] = []
  for (let i = 0; i < 20; i++) execs.push(await time(() => sh(sandbox, 'true')))
  report('command on a running VM', stats(execs))

  const nodes: number[] = []
  for (let i = 0; i < 10; i++) nodes.push(await time(() => sh(sandbox, 'node -e 0')))
  report('node -e 0', stats(nodes))

  const concurrent = await time(() => Promise.all(Array.from({ length: 10 }, () => sh(sandbox, 'sleep 1'))))
  report('10 concurrent `sleep 1`', `${concurrent.toFixed(0)}ms`)

  const egress: number[] = []
  for (let i = 0; i < 5; i++) {
    egress.push(await time(() => sh(sandbox, `curl -sSf -o /dev/null ${egressUrl.href}`)))
  }
  report(`HTTPS GET ${egressUrl.hostname} (curl)`, stats(egress))
  const nodeFetch = await time(() => sh(sandbox, `node -e "fetch('${egressUrl.href}').then((r) => r.text())"`))
  report(`HTTPS GET ${egressUrl.hostname} (node fetch)`, `${nodeFetch.toFixed(0)}ms including node startup`)

  await sh(sandbox, 'cd /tmp && for i in 1 2 3; do tsc --version >/dev/null; node -e "Array.from({length: 1e6}, (_, i) => i * 2)"; done')
  report('host RSS after some work', `${rssMb(pid).toFixed(0)}MB`)
  await sandbox.stop()

  let fleet: Sandbox[] = []
  const ready = await time(async () => {
    fleet = await Promise.all(Array.from({ length: parallel }, () => start()))
    await Promise.all(fleet.map((s) => sh(s, 'true')))
  })
  const total = fleet.reduce((sum, s) => sum + rssMb(s.hostPid()), 0)
  report(`${parallel} VMs in parallel`, `ready in ${ready.toFixed(0)}ms, ${total.toFixed(0)}MB host RSS total`)
  await Promise.all(fleet.map((s) => s.stop()))
}

if (run('vfs')) {
  const vfsCpus = Number(process.env.BENCH_VFS_CPUS ?? 2)
  console.log(`\ntsc --noEmit and vitest run on a generated project (40 modules, 20 test files), 2G VM, ${vfsCpus} vCPUs`)
  const root = mkdtempSync(join(tmpdir(), 'hobwork-bench-'))
  const projects = ['a', 'c', 'd'].map((name) => join(root, name))
  for (const dir of projects) writeProject(dir)
  const [a, c, d] = projects as [string, string, string]
  const sandbox = await start({
    memory: '2G',
    cpus: vfsCpus,
    diskSize: '4G',
    mounts: {
      '/mnt/a': { hostPath: a },
      '/mnt/c': { hostPath: c, vmDisk: ['node_modules'] },
      '/mnt/d': { hostPath: d, vmDisk: ['node_modules'] },
    },
  })
  try {
    // A full copy of the platform set in the project, as if the project installed everything itself.
    const copy = await time(() => sh(sandbox, 'cp -a /opt/hobwork/platform/node_modules /mnt/a/node_modules'))
    report('copy platform node_modules into mount', `${copy.toFixed(0)}ms`)
    await sh(sandbox, 'cp -a /opt/hobwork/platform/node_modules/. /mnt/d/node_modules/')
    await sh(sandbox, 'mkdir -p /srv && cp -a /mnt/c /srv/b')

    const layouts: [string, string][] = [
      ['(a) all mounted, node_modules in mount', '/mnt/a'],
      ['(b) all on VM disk', '/srv/b'],
      ['(c) mounted source, platform set from image', '/mnt/c'],
      ['(d) mounted source, node_modules on VM disk', '/mnt/d'],
    ]
    for (const [label, dir] of layouts) {
      const tsc: number[] = []
      const vitest: number[] = []
      for (let i = 0; i < 3; i++) {
        // Binaries come from the nearest node_modules, like `pnpm run` does.
        tsc.push(await time(() => sh(sandbox, 'PATH=$PWD/node_modules/.bin:$PATH tsc --noEmit', dir)))
        vitest.push(await time(() => sh(sandbox, 'PATH=$PWD/node_modules/.bin:$PATH vitest run --reporter=dot', dir)))
      }
      report(`${label}: tsc`, stats(tsc))
      report(`${label}: vitest`, stats(vitest))
    }
    const noIsolate: number[] = []
    for (let i = 0; i < 3; i++) noIsolate.push(await time(() => sh(sandbox, 'vitest run --reporter=dot --no-isolate', '/mnt/c')))
    report('(c) vitest --no-isolate', stats(noIsolate))
  } finally {
    await sandbox.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

